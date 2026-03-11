import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { TapStackConfig } from '../tap-stack';

export interface DatabaseStackProps {
  vpc: ec2.IVpc;
  config: TapStackConfig;
  kmsKey: kms.IKey;
}

export class DatabaseStack extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly credentials: secretsmanager.Secret;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id);

    const { vpc, config, kmsKey } = props;

    // Create credentials secret
    this.credentials = new secretsmanager.Secret(this, 'DbCredentials', {
      description: 'Aurora database credentials',
      encryptionKey: kmsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
        passwordLength: 32,
      },
    });

    // Create database security group
    this.securityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'Security group for Aurora database',
      allowAllOutbound: false,
    });

    // Create subnet group
    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      description: 'Subnet group for Aurora database',
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Create Aurora parameter group for optimization
    const parameterGroup = new rds.ParameterGroup(this, 'DbParameterGroup', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_04_2,
      }),
      parameters: {
        slow_query_log: '1',
        general_log: '1',
        log_output: 'FILE',
        max_connections: '1000',
        innodb_buffer_pool_size: '{DBInstanceClassMemory*3/4}',
      },
    });

    // Create Aurora Global Database (if primary region)
    if (config.isPrimary) {
      const globalCluster = new rds.CfnGlobalCluster(this, 'GlobalCluster', {
        globalClusterIdentifier: 'tap-global-cluster',
        engine: 'aurora-mysql',
        engineVersion: '8.0.mysql_aurora.3.04.0',
        storageEncrypted: true,
      });

      this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
        engine: rds.DatabaseClusterEngine.auroraMysql({
          version: rds.AuroraMysqlEngineVersion.VER_3_04_2,
        }),
        credentials: rds.Credentials.fromSecret(this.credentials),
        instanceProps: {
          vpc,
          vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.R6G,
            ec2.InstanceSize.XLARGE
          ),
          securityGroups: [this.securityGroup],
          parameterGroup,
        },
        instances: 2,
        backup: {
          retention: cdk.Duration.days(30),
          preferredWindow: '03:00-04:00',
        },
        storageEncrypted: true,
        storageEncryptionKey: kmsKey,
        cloudwatchLogsExports: ['error', 'general', 'slowquery', 'audit'],
        cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
        subnetGroup,
        deletionProtection: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // Associate with global cluster
      (this.cluster.node.defaultChild as rds.CfnDBCluster).addPropertyOverride(
        'GlobalClusterIdentifier',
        globalCluster.ref
      );
    } else {
      // Create secondary cluster for DR region
      this.cluster = new rds.DatabaseClusterFromSnapshot(
        this,
        'AuroraClusterDR',
        {
          snapshotIdentifier:
            'arn:aws:rds:us-east-1:XXXXXXXXXXXX:snapshot:tap-aurora-snapshot',
          engine: rds.DatabaseClusterEngine.auroraMysql({
            version: rds.AuroraMysqlEngineVersion.VER_3_04_2,
          }),
          credentials: rds.Credentials.fromSecret(this.credentials),
          instanceProps: {
            vpc,
            vpcSubnets: {
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            instanceType: ec2.InstanceType.of(
              ec2.InstanceClass.R6G,
              ec2.InstanceSize.LARGE
            ),
            securityGroups: [this.securityGroup],
            parameterGroup,
          },
          instances: 1,
          backup: {
            retention: cdk.Duration.days(7),
          },
          storageEncrypted: true,
          storageEncryptionKey: kmsKey,
          cloudwatchLogsExports: ['error', 'general', 'slowquery'],
          cloudwatchLogsRetention: logs.RetentionDays.ONE_WEEK,
          subnetGroup,
        }
      );
    }

    // Add read replicas for scaling
    if (config.isPrimary) {
      for (let i = 0; i < 2; i++) {
        new rds.CfnDBInstance(this, `ReadReplica${i}`, {
          dbInstanceClass: 'db.r6g.large',
          engine: 'aurora-mysql',
          dbClusterIdentifier: this.cluster.clusterIdentifier,
          publiclyAccessible: false,
          monitoringInterval: 60,
          monitoringRoleArn: new cdk.aws_iam.Role(this, `MonitoringRole${i}`, {
            assumedBy: new cdk.aws_iam.ServicePrincipal(
              'monitoring.rds.amazonaws.com'
            ),
            managedPolicies: [
              cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AmazonRDSEnhancedMonitoringRole'
              ),
            ],
          }).roleArn,
        });
      }
    }
  }
}

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
// import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
// import * as iam from 'aws-cdk-lib/aws-iam';
// import { NetworkingStack } from './stacks/networking-stack';
// import { DatabaseStack } from './stacks/database-stack';
// import { ComputeStack } from './stacks/compute-stack';
// import { MonitoringStack } from './stacks/monitoring-stack';
// import { DisasterRecoveryStack } from './stacks/disaster-recovery-stack';

export interface TapStackConfig {
  isPrimary: boolean;
  regionName: string;
  peerRegion: string;
  primaryStack?: TapStack;
  vpcCidr?: string;
  dbInstanceClass?: string;
  minCapacity?: number;
  maxCapacity?: number;
  desiredCapacity?: number;
  environmentSuffix?: string;
  certificateArn?: string;
}

export interface TapStackProps extends cdk.StackProps {
  environmentSuffix?: string;
  config: TapStackConfig;
}

export class TapStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly auroraCluster: rds.DatabaseCluster;
  public readonly ecsCluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly globalTable: dynamodb.Table;
  public readonly kmsKey: kms.Key;
  public readonly hostedZone?: route53.IHostedZone;
  public readonly failoverLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: TapStackProps) {
    super(scope, id, props);

    const { config, environmentSuffix } = props;
    const envSuffix = environmentSuffix || 'dev';

    // Create KMS key for encryption
    this.kmsKey = new kms.Key(this, 'MasterKmsKey', {
      description: `Master KMS key for ${config.regionName} region`,
      enableKeyRotation: true,
      alias: `alias/tap-${envSuffix}-${config.regionName}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create S3 bucket for audit logs
    new s3.Bucket(this, 'AuditBucket', {
      bucketName: `tap-audit-logs-${envSuffix}-${config.regionName}-${Date.now()}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      versioned: false,
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          expiration: cdk.Duration.days(90),
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Temporarily disabled CloudTrail due to trail limit (5 trails per region)
    // TODO: Re-enable CloudTrail after cleaning up old trails or requesting limit increase
    // Add bucket policy for CloudTrail
    // auditBucket.addToResourcePolicy(
    //   new iam.PolicyStatement({
    //     effect: iam.Effect.ALLOW,
    //     principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
    //     actions: ['s3:GetBucketAcl'],
    //     resources: [auditBucket.bucketArn],
    //     conditions: {
    //       StringEquals: {
    //         'AWS:SourceArn': `arn:aws:cloudtrail:${config.regionName}:${this.account}:trail/tap-audit-trail-${envSuffix}-${config.regionName}`,
    //       },
    //     },
    //   })
    // );

    // auditBucket.addToResourcePolicy(
    //   new iam.PolicyStatement({
    //     effect: iam.Effect.ALLOW,
    //     principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
    //     actions: ['s3:PutObject'],
    //     resources: [`${auditBucket.bucketArn}/*`],
    //     conditions: {
    //       StringEquals: {
    //         's3:x-amz-acl': 'bucket-owner-full-control',
    //         'AWS:SourceArn': `arn:aws:cloudtrail:${config.regionName}:${this.account}:trail/tap-audit-trail-${envSuffix}-${config.regionName}`,
    //       },
    //     },
    //   })
    // );

    // Add KMS key policy for CloudTrail
    // this.kmsKey.addToResourcePolicy(
    //   new iam.PolicyStatement({
    //     effect: iam.Effect.ALLOW,
    //     principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
    //     actions: ['kms:GenerateDataKey*'],
    //     resources: ['*'],
    //     conditions: {
    //       StringEquals: {
    //         'kms:EncryptionContext:aws:cloudtrail:arn': `arn:aws:cloudtrail:${config.regionName}:${this.account}:trail/tap-audit-trail-${envSuffix}-${config.regionName}`,
    //       },
    //     },
    //   })
    // );

    // Enable CloudTrail for audit logging
    // new cloudtrail.Trail(this, 'AuditTrail', {
    //   bucket: auditBucket,
    //   encryptionKey: this.kmsKey,
    //   includeGlobalServiceEvents: config.isPrimary,
    //   isMultiRegionTrail: config.isPrimary,
    //   enableFileValidation: true,
    //   trailName: `tap-audit-trail-${envSuffix}-${config.regionName}`,
    // });

    // Create VPC
    this.vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr || '10.0.0.0/16'),
      maxAzs: 3,
      natGateways: 1,
      vpcName: `tap-vpc-${envSuffix}-${config.regionName}`,
    });

    // Create Aurora Cluster
    this.auroraCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_04_2,
      }),
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      clusterIdentifier: `tap-aurora-${envSuffix}-${config.regionName}`,
      instanceProps: {
        vpc: this.vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.R6G,
          ec2.InstanceSize.XLARGE
        ),
      },
      instances: 2,
      storageEncrypted: true,
      storageEncryptionKey: this.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create DynamoDB Global Table for session management
    if (config.isPrimary) {
      this.globalTable = new dynamodb.Table(this, 'SessionTable', {
        tableName: `tap-sessions-${envSuffix}`,
        partitionKey: {
          name: 'sessionId',
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        replicationRegions: [config.peerRegion],
        stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // Add GSI for user lookups
      this.globalTable.addGlobalSecondaryIndex({
        indexName: 'UserIndex',
        partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    // Create ECS Cluster
    this.ecsCluster = new ecs.Cluster(this, 'ECSCluster', {
      vpc: this.vpc,
      clusterName: `tap-cluster-${envSuffix}-${config.regionName}`,
      containerInsights: true,
    });

    // Create Application Load Balancer
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: this.vpc,
      internetFacing: true,
      loadBalancerName: `tap-alb-${envSuffix}-${config.regionName}`,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // Create Lambda function for failover
    this.failoverLambda = new lambda.Function(this, 'FailoverFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      functionName: `tap-failover-${envSuffix}-${config.regionName}`,
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log('Failover function triggered:', JSON.stringify(event));
          return { statusCode: 200, body: 'Failover completed' };
        };
      `),
      timeout: cdk.Duration.minutes(5),
    });

    // Setup Route 53 for DNS failover
    this.setupDnsFailover(config);

    // Create comprehensive CloudWatch Dashboard
    this.createDashboard(config);

    // Setup automated backup and recovery
    this.setupBackupAndRecovery(config);

    // Create operational alarms
    this.createOperationalAlarms(config);

    // Output important values
    new cdk.CfnOutput(this, 'VPCId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${this.stackName}-VpcId`,
    });

    new cdk.CfnOutput(this, 'ALBEndpoint', {
      value: this.alb.loadBalancerDnsName,
      description: 'Application Load Balancer DNS name',
      exportName: `${this.stackName}-AlbDns`,
    });

    new cdk.CfnOutput(this, 'AuroraEndpoint', {
      value: this.auroraCluster.clusterEndpoint.hostname,
      description: 'Aurora cluster endpoint',
      exportName: `${this.stackName}-AuroraEndpoint`,
    });
  }

  private setupDnsFailover(config: TapStackConfig): void {
    // Create Route 53 health check for ALB
    const healthCheckId = `HealthCheck-${config.regionName}`;
    const healthCheck = new route53.CfnHealthCheck(this, healthCheckId, {
      healthCheckConfig: {
        type: 'HTTPS',
        resourcePath: '/health',
        fullyQualifiedDomainName: this.alb.loadBalancerDnsName,
        port: 443,
        requestInterval: 30,
        failureThreshold: 3,
      },
      healthCheckTags: [
        {
          key: 'Name',
          value: `${config.regionName}-health-check`,
        },
      ],
    });

    // Create CloudWatch alarm for health check
    new cloudwatch.Alarm(this, 'HealthCheckAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Route53',
        metricName: 'HealthCheckStatus',
        dimensionsMap: {
          HealthCheckId: healthCheck.attrHealthCheckId,
        },
      }),
      threshold: 1,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
  }

  private createDashboard(config: TapStackConfig): void {
    const envSuffix = this.node.tryGetContext('environmentSuffix') || 'dev';
    const dashboard = new cloudwatch.Dashboard(this, 'OperationalDashboard', {
      dashboardName: `TapStack-${envSuffix}-${config.regionName}`,
      start: '-PT6H',
      periodOverride: cloudwatch.PeriodOverride.INHERIT,
    });

    // Add widgets for key metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Application Performance',
        left: [
          this.alb.metricTargetResponseTime(),
          this.alb.metricRequestCount(),
        ],
        right: [
          this.alb.metricTargetResponseTime().with({
            statistic: 'p99',
          }),
        ],
        period: cdk.Duration.minutes(5),
      }),
      new cloudwatch.GraphWidget({
        title: 'Database Performance',
        left: [
          this.auroraCluster.metricCPUUtilization(),
          this.auroraCluster.metricDatabaseConnections(),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'ReadLatency',
            dimensionsMap: {
              DBClusterIdentifier: this.auroraCluster.clusterIdentifier,
            },
          }),
        ],
        period: cdk.Duration.minutes(5),
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Transaction Rate',
        metrics: [
          new cloudwatch.Metric({
            namespace: 'TapApplication',
            metricName: 'TransactionCount',
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
          }),
        ],
      })
    );
  }

  private setupBackupAndRecovery(config: TapStackConfig): void {
    const envSuffix = this.node.tryGetContext('environmentSuffix') || 'dev';

    // Create backup vault
    const backupVault = new cdk.aws_backup.BackupVault(this, 'BackupVault', {
      backupVaultName: `tap-backup-vault-${envSuffix}-${config.regionName}`,
      encryptionKey: this.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create backup plan
    const backupPlan = new cdk.aws_backup.BackupPlan(this, 'BackupPlan', {
      backupPlanName: `tap-backup-plan-${envSuffix}-${config.regionName}`,
      backupVault,
    });

    // Add backup rules
    backupPlan.addRule(
      new cdk.aws_backup.BackupPlanRule({
        ruleName: 'DailyBackup',
        scheduleExpression: cdk.aws_events.Schedule.cron({
          minute: '0',
          hour: '2',
          day: '*',
          month: '*',
          year: '*',
        }),
        deleteAfter: cdk.Duration.days(30),
        backupVault,
      })
    );

    backupPlan.addRule(
      new cdk.aws_backup.BackupPlanRule({
        ruleName: 'WeeklyBackup',
        scheduleExpression: cdk.aws_events.Schedule.cron({
          minute: '0',
          hour: '3',
          month: '*',
          year: '*',
          weekDay: 'SUN', // Sunday
        }),
        deleteAfter: cdk.Duration.days(90),
        backupVault,
      })
    );

    // Add resources to backup plan
    const backupResources = [
      cdk.aws_backup.BackupResource.fromRdsDatabaseCluster(this.auroraCluster),
    ];

    // Only add DynamoDB table if it exists (primary region only)
    if (this.globalTable) {
      backupResources.push(
        cdk.aws_backup.BackupResource.fromDynamoDbTable(this.globalTable)
      );
    }

    backupPlan.addSelection('BackupSelection', {
      resources: backupResources,
      backupSelectionName: 'CriticalResources',
    });
  }

  private createOperationalAlarms(config: TapStackConfig): void {
    const envSuffix = this.node.tryGetContext('environmentSuffix') || 'dev';

    const alarmTopic = new cdk.aws_sns.Topic(this, 'AlarmTopic', {
      displayName: 'Operational Alarms',
      topicName: `tap-alarms-${envSuffix}-${config.regionName}`,
    });

    // Add email subscription
    alarmTopic.addSubscription(
      new cdk.aws_sns_subscriptions.EmailSubscription('ops-team@example.com')
    );

    // High CPU alarm for Aurora
    new cloudwatch.Alarm(this, 'DatabaseHighCpuAlarm', {
      metric: this.auroraCluster.metricCPUUtilization(),
      threshold: 80,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'Aurora cluster CPU utilization is too high',
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));

    // High latency alarm for ALB
    new cloudwatch.Alarm(this, 'HighLatencyAlarm', {
      metric: this.alb.metricTargetResponseTime(),
      threshold: 1000, // 1 second
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Application latency is too high',
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));

    // Transaction rate alarm
    new cloudwatch.Alarm(this, 'LowTransactionRateAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'TapApplication',
        metricName: 'TransactionCount',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 500, // Less than 500 transactions in 5 minutes
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'Transaction rate is below expected threshold',
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));
  }
}

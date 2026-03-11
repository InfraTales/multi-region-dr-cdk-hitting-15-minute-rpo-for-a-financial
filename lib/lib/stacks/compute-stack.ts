import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { TapStackConfig } from '../tap-stack';

export interface ComputeStackProps {
  vpc: ec2.IVpc;
  config: TapStackConfig;
  kmsKey: kms.IKey;
  database: rds.DatabaseCluster;
  sessionTable: dynamodb.Table;
}

export class ComputeStack extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id);

    const { vpc, config, database, sessionTable } = props;

    // Create ECS Cluster
    this.cluster = new ecs.Cluster(this, 'ECSCluster', {
      vpc,
      clusterName: `tap-cluster-${config.regionName}`,
      containerInsights: true,
    });

    // Create Application Load Balancer
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      loadBalancerName: `tap-alb-${config.regionName}`,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // Create target group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
        timeout: cdk.Duration.seconds(5),
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
    });

    // Create ALB listener
    this.alb.addListener('Listener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [this.targetGroup],
    });

    // Add HTTPS listener (if certificate is available)
    if (config.certificateArn) {
      this.alb.addListener('HTTPSListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [
          elbv2.ListenerCertificate.fromArn(config.certificateArn),
        ],
        defaultTargetGroups: [this.targetGroup],
      });
    }

    // Create ECS Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'TaskDefinition',
      {
        memoryLimitMiB: 2048,
        cpu: 1024,
        family: `tap-task-${config.regionName}`,
      }
    );

    // Create container
    const container = taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry('nginx:latest'), // Replace with your app image
      memoryLimitMiB: 1024,
      cpu: 512,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'tap-app',
        logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        NODE_ENV: 'production',
        REGION: config.regionName,
        DB_ENDPOINT: database.clusterEndpoint.hostname,
        SESSION_TABLE: sessionTable.tableName,
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(
          database.secret!,
          'password'
        ),
      },
    });

    container.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    // Create ECS Service
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      desiredCount: config.desiredCapacity || 3,
      serviceName: `tap-service-${config.regionName}`,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      assignPublicIp: false,
      enableExecuteCommand: true,
    });

    // Attach service to target group
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // Create Auto Scaling Target
    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity: config.minCapacity || 2,
      maxCapacity: config.maxCapacity || 10,
    });

    // Add scaling policies
    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // Create custom metric for transaction rate
    const transactionMetric = new cdk.aws_cloudwatch.Metric({
      namespace: 'TapApplication',
      metricName: 'TransactionCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    scalableTarget.scaleOnMetric('TransactionScaling', {
      metric: transactionMetric,
      scalingSteps: [
        { upper: 1000, change: -1 },
        { lower: 2000, upper: 5000, change: +1 },
        { lower: 5000, change: +2 },
      ],
      adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
    });

    // Create IAM role for ECS tasks
    new cdk.aws_iam.Role(this, 'TaskRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
      inlinePolicies: {
        ApplicationPolicy: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              actions: [
                'rds:DescribeDBClusters',
                'rds:DescribeDBInstances',
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:Query',
                'dynamodb:Scan',
                'kms:Decrypt',
                'kms:GenerateDataKey',
                'secretsmanager:GetSecretValue',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // Update task definition with role
    taskDefinition.addToTaskRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['*'],
      })
    );
  }
}

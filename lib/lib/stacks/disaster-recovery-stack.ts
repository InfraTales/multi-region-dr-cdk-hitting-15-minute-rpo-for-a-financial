import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { TapStackConfig } from '../tap-stack';

export interface DisasterRecoveryStackProps {
  vpc: ec2.IVpc;
  config: TapStackConfig;
  kmsKey: cdk.aws_kms.IKey;
  auroraCluster: rds.DatabaseCluster;
  alb: elbv2.ApplicationLoadBalancer;
}

export class DisasterRecoveryStack extends Construct {
  public readonly failoverLambda: lambda.Function;
  public readonly healthCheckLambda: lambda.Function;
  public readonly stateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: DisasterRecoveryStackProps) {
    super(scope, id);

    const { vpc, config, auroraCluster } = props;

    // Create Lambda execution role
    const lambdaRole = new iam.Role(this, 'FailoverLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole'
        ),
      ],
      inlinePolicies: {
        FailoverPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'rds:FailoverDBCluster',
                'rds:PromoteReadReplica',
                'rds:ModifyDBCluster',
                'route53:ChangeResourceRecordSets',
                'route53:GetHealthCheck',
                'elasticloadbalancing:ModifyTargetGroup',
                'sns:Publish',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // Create Health Check Lambda
    this.healthCheckLambda = new lambda.Function(this, 'HealthCheckFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'healthCheck.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const rds = new AWS.RDS();
        const elbv2 = new AWS.ELBv2();
        
        exports.handler = async (event) => {
          console.log('Performing health checks...');
          
          const healthStatus = {
            database: false,
            loadBalancer: false,
            region: process.env.REGION_NAME,
            timestamp: new Date().toISOString()
          };
          
          try {
            // Check database health
            const dbResponse = await rds.describeDBClusters({
              DBClusterIdentifier: process.env.DB_CLUSTER_ID
            }).promise();
            
            if (dbResponse.DBClusters[0].Status === 'available') {
              healthStatus.database = true;
            }
            
            // Check ALB health
            const targetHealth = await elbv2.describeTargetHealth({
              TargetGroupArn: process.env.TARGET_GROUP_ARN
            }).promise();
            
            const healthyTargets = targetHealth.TargetHealthDescriptions.filter(
              t => t.TargetHealth.State === 'healthy'
            ).length;
            
            if (healthyTargets > 0) {
              healthStatus.loadBalancer = true;
            }
            
            return {
              statusCode: 200,
              body: JSON.stringify(healthStatus)
            };
          } catch (error) {
            console.error('Health check failed:', error);
            return {
              statusCode: 500,
              body: JSON.stringify({ error: error.message })
            };
          }
        };
      `),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      environment: {
        REGION_NAME: config.regionName,
        DB_CLUSTER_ID: auroraCluster.clusterIdentifier,
        TARGET_GROUP_ARN: '', // Will be set when target group is created
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_WEEK,
      role: lambdaRole,
    });

    // Create Failover Lambda
    this.failoverLambda = new lambda.Function(this, 'FailoverFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'failover.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const rds = new AWS.RDS();
        const route53 = new AWS.Route53();
        const sns = new AWS.SNS();
        
        exports.handler = async (event) => {
          console.log('Initiating failover process...', JSON.stringify(event));
          
          const failoverSteps = [];
          
          try {
            // Step 1: Promote read replica to master
            if (event.promoteReplica) {
              console.log('Promoting read replica...');
              await rds.promoteReadReplica({
                DBInstanceIdentifier: event.replicaId
              }).promise();
              failoverSteps.push('Read replica promoted');
            }
            
            // Step 2: Update Route 53 DNS
            if (event.updateDns) {
              console.log('Updating DNS records...');
              const changeRequest = {
                HostedZoneId: event.hostedZoneId,
                ChangeBatch: {
                  Changes: [{
                    Action: 'UPSERT',
                    ResourceRecordSet: {
                      Name: event.recordName,
                      Type: 'A',
                      AliasTarget: {
                        HostedZoneId: event.albZoneId,
                        DNSName: event.albDnsName,
                        EvaluateTargetHealth: true
                      },
                      SetIdentifier: process.env.REGION_NAME,
                      Failover: 'PRIMARY'
                    }
                  }]
                }
              };
              
              const changeResponse = await route53.changeResourceRecordSets(changeRequest).promise();
              failoverSteps.push('DNS updated: ' + changeResponse.ChangeInfo.Id);
            }
            
            // Step 3: Send notification
            await sns.publish({
              TopicArn: process.env.SNS_TOPIC_ARN,
              Subject: 'Failover Initiated',
              Message: JSON.stringify({
                region: process.env.REGION_NAME,
                timestamp: new Date().toISOString(),
                steps: failoverSteps,
                event: event
              })
            }).promise();
            
            return {
              statusCode: 200,
              body: JSON.stringify({
                message: 'Failover completed successfully',
                steps: failoverSteps
              })
            };
          } catch (error) {
            console.error('Failover failed:', error);
            
            // Send failure notification
            await sns.publish({
              TopicArn: process.env.SNS_TOPIC_ARN,
              Subject: 'Failover Failed',
              Message: JSON.stringify({
                error: error.message,
                region: process.env.REGION_NAME,
                timestamp: new Date().toISOString()
              })
            }).promise();
            
            throw error;
          }
        };
      `),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      environment: {
        REGION_NAME: config.regionName,
        SNS_TOPIC_ARN: `arn:aws:sns:${config.regionName}:${cdk.Stack.of(this).account}:tap-failover-notifications`,
      },
      timeout: cdk.Duration.minutes(15),
      logRetention: logs.RetentionDays.ONE_MONTH,
      role: lambdaRole,
    });

    // Create Step Functions state machine for orchestration
    const checkHealthTask = new sfnTasks.LambdaInvoke(this, 'CheckHealth', {
      lambdaFunction: this.healthCheckLambda,
      outputPath: '$.Payload',
    });

    const failoverTask = new sfnTasks.LambdaInvoke(this, 'ExecuteFailover', {
      lambdaFunction: this.failoverLambda,
      outputPath: '$.Payload',
    });

    const waitTask = new stepfunctions.Wait(this, 'WaitForPropagation', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const definition = checkHealthTask.next(
      new stepfunctions.Choice(this, 'IsHealthy?')
        .when(
          stepfunctions.Condition.booleanEquals('$.body.database', false),
          failoverTask.next(waitTask).next(checkHealthTask)
        )
        .otherwise(new stepfunctions.Succeed(this, 'SystemHealthy'))
    );

    this.stateMachine = new stepfunctions.StateMachine(
      this,
      'FailoverStateMachine',
      {
        definition,
        timeout: cdk.Duration.minutes(30),
        tracingEnabled: true,
        logs: {
          destination: new logs.LogGroup(this, 'StateMachineLogGroup', {
            retention: logs.RetentionDays.ONE_WEEK,
          }),
          level: stepfunctions.LogLevel.ALL,
        },
      }
    );

    // Create EventBridge rule for automated failover
    const failoverRule = new events.Rule(this, 'FailoverRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Periodic health check and failover trigger',
    });

    failoverRule.addTarget(new targets.SfnStateMachine(this.stateMachine));

    // Create manual failover trigger
    new events.Rule(this, 'ManualFailoverRule', {
      eventPattern: {
        source: ['tap.failover'],
        detailType: ['Manual Failover Trigger'],
      },
      targets: [new targets.LambdaFunction(this.failoverLambda)],
    });
  }
}

export interface IConfig {
  environment: string;
  vpcCidr: string;
  dbInstanceClass: string;
  minCapacity: number;
  maxCapacity: number;
  desiredCapacity: number;
  domainName: string;
  certificateArn: string;
  containerImage: string;
  transactionRateAlarmThreshold: number;
  backupRetentionDays: number;
}

export function loadConfig(): IConfig {
  const environment = process.env.ENVIRONMENT || 'production';

  const configs: { [key: string]: IConfig } = {
    production: {
      environment: 'production',
      vpcCidr: '10.0.0.0/16',
      dbInstanceClass: 'r6g.xlarge',
      minCapacity: 3,
      maxCapacity: 10,
      desiredCapacity: 5,
      domainName: 'app.example.com',
      certificateArn: process.env.CERTIFICATE_ARN || '',
      containerImage: 'financial-app:latest',
      transactionRateAlarmThreshold: 8000,
      backupRetentionDays: 30,
    },
    staging: {
      environment: 'staging',
      vpcCidr: '10.1.0.0/16',
      dbInstanceClass: 'r6g.large',
      minCapacity: 2,
      maxCapacity: 5,
      desiredCapacity: 3,
      domainName: 'staging.example.com',
      certificateArn: process.env.CERTIFICATE_ARN || '',
      containerImage: 'financial-app:staging',
      transactionRateAlarmThreshold: 1000,
      backupRetentionDays: 7,
    },
    dev: {
      environment: 'dev',
      vpcCidr: '10.2.0.0/16',
      dbInstanceClass: 'r6g.medium',
      minCapacity: 1,
      maxCapacity: 3,
      desiredCapacity: 2,
      domainName: 'dev.example.com',
      certificateArn: process.env.CERTIFICATE_ARN || '',
      containerImage: 'financial-app:dev',
      transactionRateAlarmThreshold: 100,
      backupRetentionDays: 3,
    },
  };

  return configs[environment] || configs.production;
}

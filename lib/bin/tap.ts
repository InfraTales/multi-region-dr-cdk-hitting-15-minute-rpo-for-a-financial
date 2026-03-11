#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Tags } from 'aws-cdk-lib';
import { TapStack } from '../lib/tap-stack';

const app = new cdk.App();

// Get environment suffix from context (set by CI/CD pipeline) or use 'dev' as default
const environmentSuffix = app.node.tryGetContext('environmentSuffix') || 'dev';
const stackName = `TapStack${environmentSuffix}`;
const repositoryName = process.env.REPOSITORY || 'unknown';
const commitAuthor = process.env.COMMIT_AUTHOR || 'unknown';

// Apply tags to all stacks in this app (optional - you can do this at stack level instead)
Tags.of(app).add('Environment', environmentSuffix);
Tags.of(app).add('Repository', repositoryName);
Tags.of(app).add('Author', commitAuthor);

// Target regions for multi-region deployment
const regions = [
  { name: 'us-east-2', isPrimary: true },
  { name: 'us-east-1', isPrimary: false },
];

// Create stacks for both regions
regions.forEach(region => {
  const stackNameRef = `${stackName}-${region.name}`;
  new TapStack(app, stackNameRef, {
    stackName: stackNameRef,
    environmentSuffix: environmentSuffix,
    config: {
      isPrimary: region.isPrimary,
      regionName: region.name,
      peerRegion: region.isPrimary ? 'us-east-1' : 'us-east-2',
      environmentSuffix: environmentSuffix,
    },
    description: `Multi-region disaster recovery infrastructure for ${region.name} (${region.isPrimary ? 'Primary' : 'DR'})`,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: region.name,
    },
    tags: {
      Environment: environmentSuffix,
      Region: region.name,
      IsPrimary: region.isPrimary.toString(),
      ManagedBy: 'CDK',
    },
  });
});

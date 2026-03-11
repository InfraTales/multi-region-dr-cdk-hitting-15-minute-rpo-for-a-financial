# Runbook

## Overview

Operational runbook for `multi-region-dr-cdk-hitting-15-minute-rpo-for-a-financial`.

## Health Checks

- Check CloudWatch alarms dashboard
- Verify all ECS tasks are running
- Confirm Aurora replication lag < 1s

## Incident Response

1. Check CloudWatch alarms
2. Review recent deployments
3. Check application logs

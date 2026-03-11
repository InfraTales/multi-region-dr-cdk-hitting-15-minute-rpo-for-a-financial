# Architecture Notes

## Overview

The design spans two AWS regions (us-east-2 primary, us-east-1 DR) using Aurora Global Database for sub-second cross-region replication as the backbone of the RPO guarantee [from-code]. Application traffic is distributed via ALBs fronting ECS Fargate services inside multi-AZ VPCs, with Route 53 health checks presumably driving automated DNS failover [inferred]. DynamoDB Global Tables handle session state so that a regional failover doesn't invalidate active user sessions — a detail most DR designs miss [from-code]. All data at rest is encrypted via KMS customer-managed keys, with Secrets Manager for credential storage and CloudWatch for cross-region observability [from-code].

## Key Decisions

- Aurora Global Database cross-region replication adds roughly $300-500/month in replication I/O and DR cluster costs, but it's what compresses RPO from hours (snapshot restore) to under a minute [inferred]
- ECS Fargate in the DR region kept warm (even at minimum capacity) burns compute budget 24/7 for a failure scenario you hope never triggers — cold-start ECS in DR during an incident almost certainly blows your 30-minute RTO [editorial]
- DynamoDB Global Tables replicate every write to both regions, doubling your DynamoDB write costs, but the alternative is losing session state on failover and forcing 10,000 tx/hr worth of users to re-authenticate mid-transaction [inferred]
- KMS CMKs are region-scoped, so you need separate key management in each region with cross-region key policies — adds IAM and key rotation operational overhead but is non-negotiable for financial compliance [from-code]
- Route 53 health-check-based DNS failover has a minimum TTL floor and health check evaluation period that makes sub-5-minute RTO via DNS alone unrealistic — this architecture's 30-minute RTO is achievable but tight [editorial]
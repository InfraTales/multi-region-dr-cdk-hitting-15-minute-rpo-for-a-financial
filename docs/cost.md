# Cost Model

## Overview

This is a reference cost model. Actual costs vary by usage.

## Key Cost Drivers

- Aurora Global Database cross-region replication adds roughly $300-500/month in replication I/O and DR cluster costs, but it's what compresses RPO from hours (snapshot restore) to under a minute [inferred]
- DynamoDB Global Tables replicate every write to both regions, doubling your DynamoDB write costs, but the alternative is losing session state on failover and forcing 10,000 tx/hr worth of users to re-authenticate mid-transaction [inferred]
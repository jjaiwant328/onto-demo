# CI/CD Lifecycle Skill — rt-onto-demo

## Architecture

```
feature/*  --PR-->  main  --tag vX.Y.Z-->  Release
    |                 |                        |
    v                 v                        v
 DEV target       STAGING target         PROD target
 rt-onto-demo-    rt-onto-demo-staging   rt-onto-demo
 dev-<user>
```

## Service Principals

| Role | Application ID | Numeric ID |
|------|----------------|------------|
| Staging | bd3dd6e7-e022-432e-975c-e8965d56ee2f | 76471424087725 |
| Prod | 675ab5ff-bb2c-4917-9d0e-e6bc807f336e | 77060664965290 |

## GitHub Variables (Settings > Actions > Variables)

| Variable | Value |
|----------|-------|
| `DATABRICKS_HOST` | `https://fe-vm-jai-classic-ws.cloud.databricks.com` |
| `DATABRICKS_SP_CLIENT_ID` | `bd3dd6e7-e022-432e-975c-e8965d56ee2f` |
| `DATABRICKS_SP_CLIENT_ID_PROD` | `675ab5ff-bb2c-4917-9d0e-e6bc807f336e` |

## OIDC Federation (Account Console)

```bash
databricks auth login --host https://accounts.cloud.databricks.com --account-id <ACCOUNT_ID>

# Staging
databricks account service-principal-federation-policy create 76471424087725 --json '{
  "oidc_policy": {
    "issuer": "https://token.actions.githubusercontent.com",
    "audiences": ["https://github.com/jjaiwant328"],
    "subject": "repo:jjaiwant328/onto-demo:ref:refs/heads/main"
  }
}'

# Prod
databricks account service-principal-federation-policy create 77060664965290 --json '{
  "oidc_policy": {
    "issuer": "https://token.actions.githubusercontent.com",
    "audiences": ["https://github.com/jjaiwant328"],
    "subject": "repo:jjaiwant328/onto-demo:environment:production"
  }
}'
```

## Developer Workflow

1. Clone: `git clone https://github.com/jjaiwant328/onto-demo.git`
2. Branch: `git checkout -b feature/my-change`
3. Deploy: `databricks bundle deploy --target dev`
4. PR to main -> CI validates
5. Merge -> staging auto-deploys
6. Release tag vX.Y.Z -> prod deploys (approval gate)

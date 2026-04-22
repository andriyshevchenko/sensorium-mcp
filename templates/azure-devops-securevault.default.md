---
name: Azure DevOps via SecureVault
triggers:
  - azure devops securevault
  - az cli securevault
  - create pr securevault
replaces_orchestrator: false
---

# Azure DevOps via SecureVault

Wrap all `az` CLI calls with `securevault run --profile azure-devops -- <command>`. PAT is injected from OS keychain as `AZURE_DEVOPS_EXT_PAT`. Agent never sees credentials.

## Before first use
```bash
securevault health   # start backend if fails: securevault &
```

## Examples
```bash
# Create PR
securevault run --profile azure-devops -- az repos pr create --repository <repo> --source-branch <branch> --target-branch main --title "title" --org <org> --project <project>

# PR threads
securevault run --profile azure-devops -- az devops invoke --area git --resource pullRequestThreads --route-parameters project=<p> repositoryId=<r> pullRequestId=<id> --org <org>

# Clone
securevault run --profile azure-devops -- git clone https://<org>@dev.azure.com/<org>/<project>/_git/<repo>

# Push
securevault run --profile azure-devops -- git push origin <branch>
```

## Rules
- ALWAYS use `securevault run --profile azure-devops --` for authenticated ops
- NEVER use `az` directly, NEVER ask for PAT values

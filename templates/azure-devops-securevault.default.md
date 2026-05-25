---
name: Azure DevOps via SecureVault
triggers:
  - azure devops
  - azure
  - az cli
  - securevault
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
- `#<number>` in Azure DevOps PR comments/descriptions auto-links to a **work item**, not a PR. To reference a PR, use the full URL: `[PR 58041](https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/58041)`

## PR Comments
When leaving comments on pull requests (e.g. replying to reviewer questions), write structured, human-readable responses:
- Use **bold** for key terms and section headers
- Use bullet lists and numbered lists for clarity
- Compare before/after when explaining a change
- Explain the "why" clearly — the reviewer is a person, not a compiler
- Keep technical but conversational — no walls of unformatted text

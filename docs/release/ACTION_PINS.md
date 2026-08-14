# GitHub Actions pin policy

Every third-party action in this repository is referenced by a full commit SHA. The trailing version comment is descriptive and does not control execution.

| Action | Upstream tag | Pinned commit |
| --- | --- | --- |
| `actions/checkout` | `v4` | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/download-artifact` | `v4` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |
| `actions/setup-node` | `v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` | `v4` | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `pnpm/action-setup` | `v4` | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
| `softprops/action-gh-release` | `v2` | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` |

Verify a proposed pin against the upstream tag before changing a workflow. Quote the peeled-tag expression in PowerShell:

```powershell
git ls-remote https://github.com/actions/checkout.git 'refs/tags/v4' 'refs/tags/v4^{}'
git ls-remote https://github.com/actions/download-artifact.git 'refs/tags/v4' 'refs/tags/v4^{}'
git ls-remote https://github.com/actions/setup-node.git 'refs/tags/v4' 'refs/tags/v4^{}'
git ls-remote https://github.com/actions/upload-artifact.git 'refs/tags/v4' 'refs/tags/v4^{}'
git ls-remote https://github.com/pnpm/action-setup.git 'refs/tags/v4' 'refs/tags/v4^{}'
git ls-remote https://github.com/softprops/action-gh-release.git 'refs/tags/v2' 'refs/tags/v2^{}'
```

For an annotated tag, use its peeled `^{}` commit. For a lightweight tag, use the tag ref itself. Review the upstream repository and release notes, then update this table and every workflow occurrence in the same pull request. Dependabot may propose action updates, but those pull requests still require pin verification and passing CI.

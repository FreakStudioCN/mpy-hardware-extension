# VS Code 扩展上架流程

本文档说明 Blockless VS Code 扩展从本地打包、内测安装到正式上架
Visual Studio Marketplace 的流程。

当前扩展信息来自 `mpy-hardware-extension/package.json`：

| 字段 | 当前值 |
| --- | --- |
| 扩展目录 | `mpy-hardware-extension/` |
| Marketplace publisher | `blockless` |
| Extension name | `mpy-hardware-extension` |
| Marketplace ID | `blockless.mpy-hardware-extension` |
| 展示名 | `Blockless` |
| 当前版本 | `0.3.3` |

官方文档：

- VS Code 发布扩展：https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- VS Code CI 发布：https://code.visualstudio.com/api/working-with-extensions/continuous-integration
- Open VSX 发布：https://github.com/eclipse/openvsx/wiki/Publishing-Extensions

## 一句话结论

后端上 Render，前端不是传统网页，而是 VS Code Extension。上架流程是：

```text
确认 Render 后端可用
  -> 检查 package.json 元信息
  -> npm test / typecheck
  -> npm run package 生成 VSIX
  -> 本地安装 VSIX 内测
  -> Azure Pipeline 用 workload identity 发布
  -> vsce publish --azure-credential 正式上架
```

## 0. 发布前提

需要准备：

- 一个 Microsoft / Azure DevOps 账号。
- 一个 Visual Studio Marketplace publisher，当前项目应使用 `blockless`。
- 一个 Entra ID workload identity 自动发布身份。
- Node.js 和 npm。
- 项目根目录的 Git submodule 已拉取完整。
- Render 后端已经部署，并且扩展默认 API 指向线上后端。

当前扩展默认后端在：

```text
mpy-hardware-extension/src/extension/api-base-url.ts
```

发布前确认默认值是线上地址，例如：

```text
https://blockless-api.onrender.com
```

## 1. 第一次上架账号准备

第一次发布才需要做这一节。

### 1.1 创建 Marketplace Publisher

打开 publisher 管理页：

```text
https://marketplace.visualstudio.com/manage/publishers/
```

创建 publisher 时，ID 必须和扩展 `package.json` 里的 `publisher` 一致。
当前项目是：

```json
{
  "publisher": "blockless"
}
```

如果 Marketplace 上还没有 `blockless` 这个 publisher，需要创建它；如果已经存在，
需要让当前发布账号加入该 publisher，并拥有管理成员的权限。

### 1.2 创建 Azure DevOps 项目

官方推荐的无 PAT 自动发布路径基于 Azure DevOps + Microsoft Entra ID：

```text
Azure Pipelines
  -> Workload Identity Federation
  -> User-assigned Managed Identity
  -> Visual Studio Marketplace publisher contributor
  -> vsce publish --azure-credential
```

先准备：

1. Azure DevOps organization。
2. Azure DevOps project，例如 `blockless-release`。
3. Azure subscription。这个 subscription 主要用来承载 managed identity。

### 1.3 创建 Workload Identity Federation Service Connection

在 Azure DevOps project 里：

```text
Project Settings
  -> Service connections
  -> New service connection
  -> Azure Resource Manager
  -> Workload Identity Federation (manual)
```

先保存为 draft，记下 Azure DevOps 生成的：

- `issuer`
- `subject`
- service connection name，例如 `blockless-vsce-publish`

这些值后面要填到 Entra managed identity 的 federated credential 里。

### 1.4 创建 User-assigned Managed Identity

在 Azure Portal 里创建一个 user-assigned managed identity，例如：

```text
blockless-vsce-publisher
```

记录这些值：

- Client ID
- Tenant ID
- Subscription ID
- Resource group
- Managed identity resource name

给它最小 Azure 权限即可。官方示例会给 Reader role；它不是用来管理 Azure
资源的，核心用途是让 Azure Pipeline 通过 federation 换到一个 Entra token，
再用这个身份发布 VS Code 扩展。

### 1.5 给 Managed Identity 添加 Federated Credential

打开刚创建的 managed identity：

```text
Settings
  -> Federated credentials
  -> Add Credential
```

把 Azure DevOps service connection draft 里拿到的 `issuer` 和 `subject`
填进去。Audience 使用 Azure DevOps / Azure 默认值即可，保持和 service
connection 页面要求一致。

保存后，Azure DevOps pipeline 就可以在不保存 secret 的情况下，以这个 managed
identity 换取短期 Entra token。

### 1.6 回填并保存 Service Connection

回到 Azure DevOps 的 service connection draft，填入：

- Managed identity Client ID
- Tenant ID
- Subscription ID
- Subscription name

点击 Verify，再保存。

保存后打开该 service connection：

- 勾选或配置 Grant access permission to all pipelines，或者只授权发布 pipeline。
- 名字建议固定为 `blockless-vsce-publish`，后续 YAML 会引用它。

### 1.7 获取 Managed Identity 的 Marketplace Resource ID

Visual Studio Marketplace publisher 添加成员时，需要的是该身份在 Marketplace /
Azure DevOps 身份系统里的 resource ID。官方示例用 Azure CLI 调这个接口：

```text
https://app.vssps.visualstudio.com/_apis/profile/profiles/me
```

先在 Azure Pipelines 里跑一次临时任务：

```yaml
trigger: none
pr: none

pool:
  vmImage: ubuntu-latest

steps:
  - task: AzureCLI@2
    displayName: Get managed identity Marketplace resource ID
    inputs:
      azureSubscription: blockless-vsce-publish
      scriptType: pscore
      scriptLocation: inlineScript
      inlineScript: |
        az rest `
          -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me `
          --resource 499b84ac-1321-427f-aa17-267ca6975798
```

输出 JSON 里会有一个 `id` 字段。保存这个 `id`。

### 1.8 授权 Managed Identity 发布 Marketplace 扩展

打开：

```text
https://marketplace.visualstudio.com/manage/publishers/
```

进入 `blockless` publisher，把上一步拿到的 managed identity resource ID 加为成员，
角色给 `Contributor`。

这一步完成后，pipeline 里的 `vsce publish --azure-credential` 才有权限把
`blockless.mpy-hardware-extension` 发布到 Marketplace。

## 2. Azure Pipelines 自动发布

建议发布策略：

- PR 只跑测试、typecheck、package。
- 正式发布用手动 `workflow_dispatch` 等价的 Azure Pipelines 手动运行，或用 tag
  触发。
- 发布凭证不使用 PAT，不保存长效 secret。
- 使用 `vsce publish --azure-credential`。

示例 `azure-pipelines.publish.yml`：

```yaml
trigger: none
pr: none

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    submodules: recursive

  - task: NodeTool@0
    inputs:
      versionSpec: "22.x"
    displayName: Use Node.js

  - script: npm ci
    workingDirectory: mpy-hardware-extension
    displayName: Install extension dependencies

  - script: npm test
    workingDirectory: mpy-hardware-extension
    displayName: Run tests

  - script: npm run typecheck
    workingDirectory: mpy-hardware-extension
    displayName: Typecheck

  - script: npm run package
    workingDirectory: mpy-hardware-extension
    displayName: Package VSIX

  - task: AzureCLI@2
    displayName: Publish to Visual Studio Marketplace
    inputs:
      azureSubscription: blockless-vsce-publish
      scriptType: pscore
      scriptLocation: inlineScript
      inlineScript: |
        cd mpy-hardware-extension
        npx vsce publish --azure-credential
```

注意：

- `azureSubscription` 必须是第 1.3 节创建的 service connection 名称。
- 当前项目的 `@vscode/vsce` 是 devDependency，`npx vsce` 会使用项目内版本。
- 官方要求 `vsce >= 2.26.1` 才支持这种发布方式；当前项目是 `^3.9.2`，满足。
- `npm run package` 会先跑 `vscode:prepublish`，把扩展入口和工具链文件准备好。
- 发布前必须已经递增 `package.json` 的 `version`，否则 Marketplace 会拒绝重复版本。

## 3. 每次发布前检查

从仓库根目录开始：

```powershell
git submodule update --init --recursive
```

然后确认后端可用：

```powershell
Invoke-RestMethod https://blockless-api.onrender.com/v1/health
Invoke-RestMethod https://blockless-api.onrender.com/v1/health/ready
Invoke-RestMethod https://blockless-api.onrender.com/v1/boards
Invoke-RestMethod https://blockless-api.onrender.com/v1/skills
```

进入扩展目录：

```powershell
cd mpy-hardware-extension
npm install
npm test
npm run typecheck
```

如果后端地址换成自定义域名，先改：

```text
mpy-hardware-extension/src/extension/api-base-url.ts
```

然后再发布。

## 4. 版本号规则

Marketplace 不允许重复发布同一个版本号。每次正式发布前，都要增加
`mpy-hardware-extension/package.json` 里的 `version`。

建议规则：

- 只修 bug：patch，例如 `0.3.3` -> `0.3.4`。
- 增加用户可见功能：minor，例如 `0.3.3` -> `0.4.0`。
- 破坏兼容性：major，当前阶段尽量避免。

可以手动改 `package.json`，或者执行：

```powershell
cd mpy-hardware-extension
npm version patch --no-git-tag-version
```

如果改了对用户有意义的行为，同步更新：

```text
mpy-hardware-extension/CHANGELOG.md
```

## 5. 打包 VSIX

执行：

```powershell
cd mpy-hardware-extension
npm run package
```

这个命令会调用：

```text
vsce package --out build/
```

同时 `vsce` 会自动执行 `vscode:prepublish`，也就是：

```text
node scripts/prepare-vsce.mjs
```

该脚本会做两件关键事情：

- 把 `src/extension/activate.ts` bundle 成 `dist/extension/activate.cjs`。
- 把仓库根目录的 `third_party/MicroPython_Skills` 子模块中需要的脚本、
  schema、模板复制到扩展目录下，保证 VSIX 运行时能找到本地工具链。

如果 submodule 没拉下来，打包会失败或产物不完整。

打包产物位置：

```text
mpy-hardware-extension/build/mpy-hardware-extension-<version>.vsix
```

## 6. 本地安装 VSIX 内测

先用 VSIX 在本机测一遍，不要直接发布。

命令行安装：

```powershell
code --install-extension build/mpy-hardware-extension-<version>.vsix
```

也可以在 VS Code 里：

```text
Extensions 面板
  -> 右上角 ...
  -> Install from VSIX...
```

内测至少检查：

- Activity Bar 里能看到 Blockless 图标。
- Blockless 面板能打开。
- `/v1/boards` 加载成功。
- GitHub 登录能弹出。
- 登录后 credits 能显示。
- 能跑到生成流程。
- 连接板子时本地 shim 不缺文件。

## 7. 正式发布到 Visual Studio Marketplace

主发布方式走 Azure Pipelines：

```text
Run azure-pipelines.publish.yml
  -> service connection 换取 Entra token
  -> npx vsce publish --azure-credential
```

Azure Pipeline 中实际执行的发布命令是：

```powershell
npx vsce publish --azure-credential
```

不建议用本机 `vsce login` + PAT 作为常规发布方式。它只能作为紧急兜底，并且
不要把 PAT 存到仓库或 CI secret 里。

发布成功后，扩展会出现在 Marketplace。当前扩展的公开 ID 应是：

```text
blockless.mpy-hardware-extension
```

Marketplace 页面通常是：

```text
https://marketplace.visualstudio.com/items?itemName=blockless.mpy-hardware-extension
```

发布后用一个干净 VS Code profile 从 Marketplace 搜索并安装，确认不是只在本地
VSIX 下可用。

## 8. 手动上传 VSIX 的备选方案

如果 Azure Pipeline 发布失败，可以手动上传 VSIX 作为临时兜底：

1. 先执行 `npm run package` 生成 `.vsix`。
2. 打开：
   ```text
   https://marketplace.visualstudio.com/manage/publishers/
   ```
3. 选择 `blockless` publisher。
4. 上传生成的 VSIX。
5. 等待 Marketplace 处理完成。

手动上传和 CLI 发布本质一样，都是把 VSIX 发布到同一个 publisher 下。

## 9. 可选：Verified Publisher 域名认证

这是 Marketplace 蓝勾，不是上架必需条件。

意思是：Microsoft 允许 publisher 通过证明自己拥有某个域名，来证明这个
publisher 和某个品牌或身份有关。认证通过后，扩展详情页会显示 verified
publisher 标识。

没有域名也可以先发布扩展。域名认证只影响可信标识，不影响基础上架。

官方当前要求大致是：

- publisher 至少已经在 VS Marketplace 有一个扩展满 6 个月。
- 用来认证的域名注册时间也至少满 6 个月。
- 域名要和你的品牌或身份相关。
- Microsoft 会检查域名、网站、扩展历史、内容合法性、可信度、声誉等。

所以不要随便填：

- `github.com`：不是你的域名。
- `onrender.com`：不是你的域名。
- `vercel.app` / `netlify.app`：通常只是平台子域，不适合证明品牌所有权。
- 刚买的新域名：未满 6 个月，通常不能立刻用于 verified publisher。

更合理的是买并长期持有一个品牌域名，例如：

```text
blockless.dev
blocklessai.com
```

域名认证跟 Entra workload identity 发布是两件事：

```text
workload identity -> 让 CI 不用 PAT 也能发布
verified domain  -> 让 Marketplace 显示 verified publisher 标识
```

当前阶段建议：

1. 先完成 Azure Pipelines + `vsce publish --azure-credential` 上架。
2. 同时买一个品牌域名，放官网、隐私政策、支持邮箱等。
3. 等 publisher 和域名都满足 6 个月要求后，再申请 verified publisher。

## 10. 可选：发布到 Open VSX

Visual Studio Marketplace 覆盖官方 VS Code。VSCodium、部分云 IDE 和开源
VS Code 分发版通常使用 Open VSX。

如果要覆盖这些用户，再做 Open VSX：

1. 注册 Open VSX / Eclipse 账号。
2. 接受 publisher agreement。
3. 生成 Open VSX access token。
4. 创建 namespace，必须和 `package.json` 的 `publisher` 一致：
   ```powershell
   npx ovsx create-namespace blockless -p <OVSX_TOKEN>
   ```
5. 发布已经打好的 VSIX：
   ```powershell
   npx ovsx publish build/mpy-hardware-extension-<version>.vsix -p <OVSX_TOKEN>
   ```

建议优先顺序：

```text
VSIX 内测 -> Visual Studio Marketplace -> Open VSX
```

## 11. PAT 兜底方案

不使用 PAT 作为主流程。但如果 workload identity 尚未配好，而你必须先发一个
紧急版本，可以临时使用 PAT：

```powershell
cd mpy-hardware-extension
npx vsce login blockless
npm run publish
```

PAT 创建时只给 Marketplace: Manage scope。发布后尽快删除或失效该 token。
不要把它写进 GitHub Actions secrets；否则就绕回了长效 secret 模式。

## 12. 常见失败

### Publisher 不匹配

报错类似 publisher 不存在或无权限。

检查：

```text
mpy-hardware-extension/package.json -> publisher
```

必须和 Marketplace publisher ID 完全一致。

### 版本号重复

Marketplace 不允许覆盖同版本。增加 `package.json` 的 `version` 后重新打包发布。

### `vsce publish --azure-credential` 无权限

优先检查：

- Azure Pipeline 使用的 service connection 是不是 `blockless-vsce-publish`。
- Service connection 是否已经 grant 给当前 pipeline。
- Managed identity 的 federated credential 里的 issuer / subject 是否和 service
  connection 完全匹配。
- Managed identity resource ID 是否已经被加到 `blockless` publisher 成员里。
- Marketplace 成员角色是否是 `Contributor`。

### 拿不到 Marketplace resource ID

确认临时 AzureCLI 任务使用了正确 resource：

```text
499b84ac-1321-427f-aa17-267ca6975798
```

并且任务跑在配置好的 `blockless-vsce-publish` service connection 下。

### icon / README 资源不合规

VS Code Marketplace 对资源有限制：

- `package.json` 的 `icon` 不能是 SVG。
- README / CHANGELOG 里的图片 URL 要用 HTTPS。
- README / CHANGELOG 里的 SVG 图片有额外限制。

当前 `package.json` 使用的是：

```json
"icon": "media/icon.png"
```

这是正确方向。Activity Bar 贡献点里的 `media/icon.svg` 是 VS Code UI 图标，不是
Marketplace 包图标。

### VSIX 缺工具链文件

症状：扩展安装后能打开，但生成、wiring、diagram、shim 相关步骤找不到脚本或 schema。

优先检查：

```powershell
git submodule update --init --recursive
npm run package
```

因为 `scripts/prepare-vsce.mjs` 需要从仓库根目录的
`third_party/MicroPython_Skills` 复制运行时工具链。

### 发布后用户连到本地后端

发布版本不能默认指向 `127.0.0.1`。检查：

```text
mpy-hardware-extension/src/extension/api-base-url.ts
```

生产默认应该是线上 API。用户需要自托管时，才通过 VS Code 设置
`mpyhw.apiBaseUrl` 覆盖。

## 13. 发布检查清单

发布前逐项打勾：

- [ ] Render 后端 `/v1/health/ready` 正常。
- [ ] Render 后端 `/v1/boards` 和 `/v1/skills` 正常。
- [ ] `api-base-url.ts` 默认指向线上 API。
- [ ] `package.json` 的 `publisher` 是 `blockless`。
- [ ] `package.json` 的 `version` 已递增。
- [ ] `CHANGELOG.md` 已更新。
- [ ] `git submodule update --init --recursive` 已执行。
- [ ] `npm test` 通过。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run package` 生成 VSIX。
- [ ] 本地安装 VSIX 验证通过。
- [ ] Azure DevOps service connection `blockless-vsce-publish` 已配置。
- [ ] Managed identity 已加入 `blockless` publisher，角色是 `Contributor`。
- [ ] Azure Pipeline 执行 `npx vsce publish --azure-credential` 发布成功。
- [ ] Marketplace 安装验证通过。

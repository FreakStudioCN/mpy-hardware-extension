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

需要准备（全程务必用**同一个微软账号**登录这几个站点，否则身份串不起来）：

- 一个微软账号（Marketplace / Azure DevOps / Azure Portal 共用）。
- 一个 Visual Studio Marketplace publisher：<https://marketplace.visualstudio.com/manage>，当前项目用 `blockless`。
- 一个 Azure DevOps organization：<https://aex.dev.azure.com/>。
- 一个 Azure subscription（用来承载 managed identity；没有就免费开一个）：<https://azure.microsoft.com/free/>。
- 一个 Entra ID workload identity 自动发布身份（下面 1.4–1.6 创建）。
- Node.js 和 npm。
- 项目根目录的 Git submodule 已拉取完整。
- Render 后端已经部署，并且扩展默认 API 指向线上后端。

> 下面凡是出现 `{org}`、`{project}` 的链接，把它替换成你自己的 Azure DevOps
> 组织名和项目名。例如组织叫 `blockless`、项目叫 `blockless-release`，则
> `https://dev.azure.com/{org}/{project}` 就是 `https://dev.azure.com/blockless/blockless-release`。

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

### 1.1 创建 Marketplace Publisher ✅（已完成）

publisher 管理页：<https://marketplace.visualstudio.com/manage>

创建 publisher 时，ID 必须和扩展 `package.json` 里的 `publisher` 一致：

```json
{
  "publisher": "blockless"
}
```

本项目的 `blockless` publisher 已创建好，直链：
<https://marketplace.visualstudio.com/manage/publishers/blockless>。
如果换账号操作，需要让该账号加入此 publisher 并拥有管理成员权限。

### 1.2 创建 Azure DevOps 组织、项目和订阅

整条无 PAT 自动发布链是：

```text
Azure Pipelines
  -> Workload Identity Federation（service connection）
  -> User-assigned Managed Identity
  -> 加为 Marketplace publisher 的 Contributor
  -> vsce publish --azure-credential
```

需要三样东西，逐个建：

**(a) Azure DevOps organization**

打开 <https://aex.dev.azure.com/>，用你的微软账号登录。

- 如果已有组织，会列出来，记下组织名（URL 里的 `{org}`）。
- 如果没有，点 **Create new organization**，按引导建一个（名字会成为
  `https://dev.azure.com/{org}` 里的 `{org}`，建议用 `blockless`）。

**(b) Azure DevOps project**

进入组织 <https://dev.azure.com/{org}>，点右上角 **+ New project**：

- Project name：`blockless-release`
- Visibility：Private
- Create。

建好后项目主页就是 `https://dev.azure.com/{org}/blockless-release`。

**(c) Azure subscription**

managed identity 必须挂在一个 Azure 订阅下。打开
<https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBlade>
看有没有订阅。

- 有：记下 Subscription ID 和 Subscription name（1.6 要回填）。
- 没有：去 <https://azure.microsoft.com/free/> 免费开一个（需要绑信用卡做身份
  验证；本流程只用到极少量甚至零 Azure 资源费用）。

### 1.3 创建 Workload Identity Federation Service Connection

直接打开 service connections 页：
<https://dev.azure.com/{org}/blockless-release/_settings/adminservices>
（等价路径：项目主页 → 左下 **Project settings** → **Service connections**）。

1. **New service connection** → 选 **Azure Resource Manager** → Next。
2. 认证方式选 **Workload Identity federation (manual)** → Next。
3. Service connection name 填 **`blockless-vsce-publish`**（务必和
   `azure-pipelines.publish.yml` 里的 `azureServiceConnection` 一致）→ 先 **Save**
   存成 draft。

存成 draft 后，页面会显示这两个值，**复制下来**（1.5 要填进 managed identity）：

- **Issuer**（形如 `https://vstoken.dev.azure.com/{guid}`）
- **Subject identifier**（形如 `sc://{org}/blockless-release/blockless-vsce-publish`）

先别关这个页面，1.6 还要回来填值。

### 1.4 创建 User-assigned Managed Identity

打开创建页：<https://portal.azure.com/#create/Microsoft.ManagedIdentity>
（等价路径：portal 搜索框输入 **Managed Identities** → **+ Create**）。

1. Subscription：选 1.2(c) 那个订阅。
2. Resource group：没有就点 **Create new**，名字如 `blockless-rg`。
3. Region：就近选（如 East Asia）。
4. Name：**`blockless-vsce-publisher`**。
5. Review + create → Create。

创建完点 **Go to resource**，在 **Overview** 页记下（1.6 回填用）：

- **Client ID**
- **Subscription ID** / Subscription name
- **Resource group**、Name（`blockless-vsce-publisher`）

Tenant ID 在 portal 右上角账号 → **Switch directory**，或
<https://portal.azure.com/#view/Microsoft_AAD_IAM/TenantPropertiesBlade> 可查。

> 这个身份本身**不需要任何 Azure 角色权限**——它不去管理 Azure 资源，只是给
> Azure Pipeline 一个可被 federation 信任的身份去发布扩展。所以不用给它 Reader
> 之类的 role。

### 1.5 给 Managed Identity 添加 Federated Credential

还在 1.4 那个 managed identity 资源页，左侧菜单：
**Settings → Federated credentials → + Add Credential**。

1. Federated credential scenario：选 **Other issuer**（不是 GitHub / Kubernetes）。
2. **Issuer**：粘贴 1.3 draft 里的 Issuer。
3. **Subject identifier**：粘贴 1.3 draft 里的 Subject identifier。
4. Name：随便起个可读名，如 `blockless-devops`。
5. Audience：保持默认 `api://AzureADTokenExchange`（与 Azure DevOps 默认一致）。
6. Add。

保存后，这个 managed identity 就信任由那条 service connection 签发的令牌，
Azure Pipeline 即可在不存任何 secret 的前提下换取短期 Entra token。

### 1.6 回填并保存 Service Connection

回到 1.3 的 service connection draft（
<https://dev.azure.com/{org}/blockless-release/_settings/adminservices> →
点开 `blockless-vsce-publish` → Edit），把 1.4 记下的值填进去：

- **Service Principal Id**（即 managed identity 的 **Client ID**）
- **Tenant ID**
- **Subscription ID**
- **Subscription Name**

点 **Verify**（应显示成功），再 **Save**。

保存后打开该 service connection 的 **…（更多）→ Security**：

- 打开 **Grant access permission to all pipelines**（图省事），或单独授权发布
  pipeline。
- 确认名字是 `blockless-vsce-publish`——`azure-pipelines.publish.yml` 里的
  `azureServiceConnection` 就引用它。

### 1.7 获取 Managed Identity 的 Marketplace Resource ID

把这个身份加到 Marketplace publisher 成员时，需要的是它在 Azure DevOps 身份系统
里的 **profile id**。这个 id 必须**以 managed identity 自己的身份**去查，所以本机
`az login`（那是你个人身份）查不到——只能在 pipeline 里通过 service connection 查。

打开 Pipelines：<https://dev.azure.com/{org}/blockless-release/_build> → **New
pipeline** → 源选你的仓库 → 选 **Starter pipeline** → 把内容整段替换成下面这段 →
**Save and run**（可先建一个 `ci/get-resource-id` 分支跑，不污染 main）：

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
      scriptType: bash
      scriptLocation: inlineScript
      inlineScript: |
        az rest \
          -u "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1" \
          --resource 499b84ac-1321-427f-aa17-267ca6975798
```

> `499b84ac-1321-427f-aa17-267ca6975798` 是 Azure DevOps 的固定 resource id，照抄。

跑完点开这一步的日志，输出 JSON 里有个 **`id`** 字段（形如
`aaaaaaaa-bbbb-...`）。**复制这个 `id`**，1.8 要用。用完这条临时 pipeline 可以删掉。

### 1.8 授权 Managed Identity 发布 Marketplace 扩展

打开 publisher 直链：
<https://marketplace.visualstudio.com/manage/publishers/blockless> →
顶部 **Members** 标签 → **Add**。

- 在用户框里粘贴 1.7 拿到的那个 **`id`**（managed identity 的 profile id）。
- Role 选 **Contributor**（或更高）。
- 添加。

这一步完成后，pipeline 里的 `vsce publish --azure-credential` 才有权限把
`blockless.mpy-hardware-extension` 发布到 Marketplace。至此 1.x 全部配完。

## 2. Azure Pipelines 自动发布

发布策略：

- 发布 = 手动跑仓库根目录的 `azure-pipelines.publish.yml`（`trigger: none`，只能手动点）。
- 测试 = GitHub Actions（`.github/workflows/ci.yml`），**只测不发**。
- 发布凭证走 workload identity federation，不用 PAT、不存长效 secret。

发布流水线已经提交在仓库里，不用再手抄 YAML：

```text
azure-pipelines.publish.yml
```

> 它和官方示例有一处关键区别：用 `core.symlinks=false` + 手动
> `git submodule update` 拉子模块。因为上游 GraftSense 提交了一个损坏的 symlink
> blob，直接 `submodules: recursive` 在 Linux agent 上会以 ENAMETOOLONG 失败
> （和 `.github/workflows/ci.yml` 同一处坑、同一个修法）。

**在 Azure DevOps 里把它接成一条 pipeline（一次性）：**

1. 打开 <https://dev.azure.com/{org}/blockless-release/_build> → **New pipeline**。
2. 源选你的仓库（GitHub 仓库要先授权 Azure Pipelines 访问）。
3. 选 **Existing Azure Pipelines YAML file**，路径选
   `/azure-pipelines.publish.yml` → Continue → Save（先别 Run）。
4. 以后要发版，进这条 pipeline 点 **Run pipeline** 即可。

注意：

- YAML 里的 `azureSubscription: blockless-vsce-publish` 必须等于 1.3 的 service
  connection 名；不一致会在发布步报无权限。
- `@vscode/vsce` 是 devDependency，`npx vsce` 用项目内版本（`^3.9.2`，满足
  `--azure-credential` 要求的 ≥ 2.26.1）。
- `npm run package` 会先跑 `vscode:prepublish`，bundle 入口并 vendor 工具链。
- **首次发布**：publisher 是空的，`0.3.3` 还没发过，可直接发 0.3.3，无需 bump；
  之后每次重发都要先递增 `package.json` 的 `version`（见第 4 节）。

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

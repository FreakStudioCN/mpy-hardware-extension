# VS Code 扩展上架流程

本文档说明 Blockless VS Code 扩展从本地打包、内测安装到正式上架
Visual Studio Marketplace 的流程。**用 PAT 发布**——可走 GitHub Actions「打 tag
自动发布」，或本机手动发布；两者都不依赖 Azure 订阅、不花钱。

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
- 创建 PAT：https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate
- Open VSX 发布：https://github.com/eclipse/openvsx/wiki/Publishing-Extensions

## 一句话结论

后端上 Render，前端不是传统网页，而是 VS Code Extension。上架流程是：

```text
确认 Render 后端可用
  -> 检查 package.json 元信息
  -> npm test / typecheck
  -> npm run package 生成 VSIX
  -> 本地安装 VSIX 内测
  -> 递增 version + 打 v* tag 推送 -> GitHub Actions 自动发布
     （或本地 vsce login blockless + npm run publish）
```

## 0. 发布前提

需要准备：

- 一个微软账号（Marketplace 和 Azure DevOps 共用，用来生成 PAT）。
- Visual Studio Marketplace publisher `blockless`（已创建）：
  <https://marketplace.visualstudio.com/manage/publishers/blockless>。
- 一个 Azure DevOps organization——**仅用来签发 PAT**，免费，不需要 Azure
  订阅、不需要花钱：<https://aex.dev.azure.com/>。
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

> 不想长期持有 token、要团队 CI 一键发布、想做到“云端零 secret”？那是另一条
> workload identity 路线，步骤多、私有项目跑流水线还要申请并行额度。完整步骤保留
> 在 git 历史（commit `0ed0383` 的本文件 + `azure-pipelines.publish.yml`），有需要
> 再捡起来。本文件只讲 PAT。

## 1. 第一次准备账号（一次性）

第一次发布才需要做这一节。

### 1.1 Marketplace Publisher ✅（已完成）

publisher 直链：<https://marketplace.visualstudio.com/manage/publishers/blockless>。
它的 ID 必须和 `package.json` 的 `publisher` 一致，当前都是 `blockless`。

### 1.2 创建 Marketplace 发布 PAT

PAT（Personal Access Token）是从 Azure DevOps 签发的一个令牌，`vsce` 用它向
Marketplace 证明你有权以 `blockless` 身份发布。

1. 如果还没有 Azure DevOps 组织，先去 <https://aex.dev.azure.com/> 用同一个微软
   账号免费建一个（建议名字 `blockless`）。组织本身免费，不涉及任何付费。
2. 打开 token 页：<https://dev.azure.com/{org}/_usersSettings/tokens>
   （把 `{org}` 换成你的组织名；等价路径：右上角头像 → **Personal access tokens**）。
3. 点 **+ New Token**，按下面填：
   - **Name**：`blockless-marketplace-publish`
   - **Organization**：选 **All accessible organizations**（很关键，Marketplace 是
     跨组织资源，选单个组织会发布时报无权限）
   - **Expiration**：按需，默认 30 天，可设到 1 年/自定义
   - **Scopes**：点 **Show all scopes**，找到 **Marketplace**，勾 **Manage**
4. **Create**，复制生成的 token。**离开页面后再也看不到**，先存到安全的地方
   （密码管理器）。绝不要把明文 token 提交进仓库或贴进代码。

这个 token 两种发布方式都用得到（见第 6 节）：

- **走 GitHub Actions 自动发布**：把它存成仓库 secret `VSCE_PAT`——打开
  仓库 → **Settings → Secrets and variables → Actions → New repository secret**，
  Name 填 `VSCE_PAT`，Value 粘贴 token。（这是把 token 加密存进 GitHub，只对
  workflow 可见、日志里会打码。）
- **走本地手动发布**：不用存到任何地方，发布时 `vsce login` 现场粘贴即可。

## 2. 每次发布前检查

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

## 3. 版本号规则

Marketplace 不允许重复发布同一个版本号。

- **首次发布**：publisher 是空的，`0.3.3` 还没发过，可直接发 0.3.3，无需 bump。
- **之后每次重发**：都要先增加 `mpy-hardware-extension/package.json` 的 `version`。

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

## 4. 打包 VSIX

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

## 5. 本地安装 VSIX 内测

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

## 6. 发布到 Marketplace

两种方式，用同一个 PAT，二选一。**推荐 6.1（打 tag 自动发）**，6.2 作为备选/应急。

### 6.1 GitHub Actions 自动发布（打 tag 即发）

一次性准备：按 1.2 把 PAT 存成仓库 secret `VSCE_PAT`。

之后每次发版，在仓库根目录：

```powershell
cd mpy-hardware-extension
npm version patch --no-git-tag-version   # 递增版本；首发 0.3.3 可跳过这条
cd ..
git commit -am "release v0.3.4"
git push
git tag v0.3.4
git push origin v0.3.4
```

推送 `v*` tag 会触发 `.github/workflows/ci.yml` 的 `publish-extension` job：它先等
测试通过，再用 `vsce publish -p $VSCE_PAT` 自动发布 `package.json` 里的版本。去仓库
**Actions** 页看运行结果。

> 安全说明：这个 job 只在推送 `v*` tag 时跑，而推 tag 需要仓库写权限——fork 的 PR
> 触碰不到这个 secret，所以即使仓库公开也安全。GitHub 把 secret 加密存储、日志里
> 打码。tag 名（`v0.3.4`）和 `package.json` 的 `version`（`0.3.4`）要对应。

### 6.2 本地手动发布（备选 / 应急）

不想走 CI、或想立刻发一版时，在扩展目录里：

```powershell
cd mpy-hardware-extension
npx vsce login blockless   # 提示时粘贴 1.2 的 PAT
npm run publish            # = vsce publish，会重新打包并上传
```

也可以一条命令、不预先 login：

```powershell
npx vsce publish -p <你的PAT>
```

### 发布之后

不论哪种方式，扩展的公开 ID 是：

```text
blockless.mpy-hardware-extension
```

Marketplace 页面：

```text
https://marketplace.visualstudio.com/items?itemName=blockless.mpy-hardware-extension
```

发布后用一个干净 VS Code profile 从 Marketplace 搜索并安装，确认不是只在本地
VSIX 下可用。

> PAT 会自动过期。过期后回 1.2 的 token 页 regenerate 一个，再更新 `VSCE_PAT`
> secret（6.1）或重新 `vsce login`（6.2）。怀疑泄露就立刻去同一页面 revoke。

## 7. 手动上传 VSIX 的备选方案

如果 `vsce publish` 出问题，可以手动上传 VSIX 作为兜底：

1. 先执行 `npm run package` 生成 `.vsix`。
2. 打开 <https://marketplace.visualstudio.com/manage/publishers/blockless>。
3. 上传生成的 VSIX（`+ New extension` → VS Code，或在已有扩展上 `Update`）。
4. 等待 Marketplace 处理完成。

手动上传和 CLI 发布本质一样，都是把 VSIX 发布到同一个 publisher 下。

## 8. 可选：发布到 Open VSX

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

## 9. 可选：Verified Publisher 域名认证

这是 Marketplace 蓝勾，不是上架必需条件。Microsoft 允许 publisher 通过证明自己
拥有某个域名，来证明这个 publisher 和某个品牌或身份有关。认证通过后，扩展详情页
会显示 verified publisher 标识。没有域名也可以先发布扩展。

官方当前要求大致是：

- publisher 至少已经在 VS Marketplace 有一个扩展满 6 个月。
- 用来认证的域名注册时间也至少满 6 个月。
- 域名要和你的品牌或身份相关。
- Microsoft 会检查域名、网站、扩展历史、内容合法性、可信度、声誉等。

所以不要随便填 `github.com`、`onrender.com`、`vercel.app` 这类不属于你或只是平台
子域的域名，也不要用刚买的新域名。更合理的是买并长期持有一个品牌域名，例如：

```text
blockless.dev
blocklessai.com
```

当前阶段建议：先用 PAT 把扩展发上去，同时买一个品牌域名放官网/隐私政策/支持邮箱，
等 publisher 和域名都满 6 个月后再申请 verified publisher。

## 10. 常见失败

### `vsce login` / 发布报 401 或无权限

按顺序检查 PAT：

- Scope 是不是 **Marketplace → Manage**（不是 Read）。
- Organization 是不是 **All accessible organizations**（选单个组织会失败）。
- token 是否已过期——过期就回 1.2 重新生成。
- 登录用的 publisher 名是不是 `blockless`，且和 `package.json` 的 `publisher` 一致。

### Publisher 不匹配

报错类似 publisher 不存在或无权限。检查 `mpy-hardware-extension/package.json` 的
`publisher` 必须和 Marketplace publisher ID（`blockless`）完全一致。

### 版本号重复

Marketplace 不允许覆盖同版本。增加 `package.json` 的 `version` 后重新打包发布。

### icon / README 资源不合规

VS Code Marketplace 对资源有限制：

- `package.json` 的 `icon` 不能是 SVG。
- README / CHANGELOG 里的图片 URL 要用 HTTPS。
- README / CHANGELOG 里的 SVG 图片有额外限制。

当前 `package.json` 使用的是 `"icon": "media/icon.png"`，方向正确。Activity Bar
贡献点里的 `media/icon.svg` 是 VS Code UI 图标，不是 Marketplace 包图标。

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

发布版本不能默认指向 `127.0.0.1`。检查
`mpy-hardware-extension/src/extension/api-base-url.ts`，生产默认应该是线上 API。
用户需要自托管时，才通过 VS Code 设置 `mpyhw.apiBaseUrl` 覆盖。

## 11. 发布检查清单

发布前逐项打勾：

- [ ] Render 后端 `/v1/health/ready` 正常。
- [ ] Render 后端 `/v1/boards` 和 `/v1/skills` 正常。
- [ ] `api-base-url.ts` 默认指向线上 API。
- [ ] `package.json` 的 `publisher` 是 `blockless`。
- [ ] `package.json` 的 `version` 已递增（首次发 0.3.3 可跳过）。
- [ ] `CHANGELOG.md` 已更新。
- [ ] `git submodule update --init --recursive` 已执行。
- [ ] `npm test` 通过。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run package` 生成 VSIX。
- [ ] 本地安装 VSIX 验证通过。
- [ ] 持有有效的 Marketplace PAT（scope = Manage，org = all accessible）。
- [ ] 发布方式二选一已就绪：
  - 自动：GitHub secret `VSCE_PAT` 已配置，打 `v*` tag 触发发布。
  - 手动：`vsce login blockless` + `npm run publish`。
- [ ] 发布成功（看 Actions 页或命令输出）。
- [ ] Marketplace 安装验证通过。

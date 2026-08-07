# 一朵云项目迭代规划

GitHub Pages 静态站点，使用仓库中的 `data/iteration-plan.json` 作为唯一共享数据源。

## 启用多人协作

此站点采用开放编辑模式：访问页面即可查看和编辑，不需要 GitHub 账号或令牌。浏览器通过 CloudBase HTTP 网关调用云函数；云函数再调用 GitHub Contents API 更新共享文件。

环境管理员需要在 CloudBase 环境 `yiduoyun-iteration-plan-d36f964e` 完成一次性配置：

1. 在“云函数”创建普通云函数 `github-plan-gateway`，上传本仓库 `cloudfunctions/github-plan-gateway` 目录中的 `index.js` 和 `package.json`，入口函数为 `index.main`。
2. 在云函数的环境变量中设置 `GITHUB_TOKEN`：使用仅限 `shitongwang-boop/yiduoyun-iteration-plan` 仓库、只具备 `Contents: Read and write` 权限的细粒度令牌。
3. 在“HTTP 网关”添加公开路由 `/github-plan-gateway`，关联该云函数，启用跨域且关闭身份认证。当前默认访问地址为 `https://yiduoyun-iteration-plan-d36f964e-1464772066.ap-shanghai.app.tcloudbase.com/github-plan-gateway`；如控制台生成的地址不同，将它填入 `collaboration-config.js` 的 `gatewayUrl`。
4. 可选：设置环境变量 `ALLOWED_ORIGIN=https://shitongwang-boop.github.io`，限制只有该网站可调用网关。

GitHub 令牌只存在 CloudBase 环境变量中，不会发送给网站访问者。页面每 10 秒读取一次共享文件，保存时由网关创建 Git 提交。

## 权限与并发

- 所有访问者均可调整顺序和日期。
- 网关保存前会读取最新版文件；发生并发更新时，不同主题或日期的调整会自动合并并重试。
- GitHub 会保留每次修改的提交历史。开放编辑意味着任何能访问网站的人都可发起修改。

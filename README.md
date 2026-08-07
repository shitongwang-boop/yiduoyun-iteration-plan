# 一朵云项目迭代规划

GitHub Pages 静态站点，使用仓库中的 `data/iteration-plan.json` 作为唯一共享数据源。

## 启用多人协作

1. 将允许编辑的成员添加为 `shitongwang-boop/yiduoyun-iteration-plan` 仓库的协作者，并授予 Write 权限。
2. 每位编辑者在 GitHub 的 Settings > Developer settings > Personal access tokens > Fine-grained tokens 新建令牌。
3. 令牌只选择该仓库，并授予 Repository permissions 中的 Contents: Read and write；不需要其他权限。
4. 在网站右上角点击“GitHub 授权”，粘贴令牌后即可编辑。

令牌只保存在当前浏览器会话，关闭浏览器标签页后需要再次授权。页面每 15 秒读取一次共享文件，保存时通过 GitHub Contents API 创建提交。

## 权限与并发

- 未授权用户可查看共享规划，授权用户可调整顺序和日期。
- GitHub 会记录每次修改的提交人、时间和完整文件历史。
- 保存前会读取最新版文件；发生并发更新时，不同主题或日期的调整会自动合并并重试。
- 需要即时通知时刷新页面即可；常规同步间隔为 15 秒。

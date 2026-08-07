# 一朵云项目迭代规划

GitHub Pages 静态站点，使用 Supabase 保存共享规划并通过 Realtime 推送最新状态。

## 启用多人协作

1. 新建一个 Supabase 项目，在 SQL Editor 中执行 `supabase/migrations/001_iteration_plan_realtime.sql`。
2. 在 Supabase 的 Authentication 设置中配置 Site URL：
   `https://shitongwang-boop.github.io/yiduoyun-iteration-plan/`。
3. 将同一地址加入 Redirect URLs。关闭 Allow new users to sign up，并从 Users 页面邀请允许编辑的成员；如确实允许任意邮箱参与，再保留公开注册。
4. 在 Project Settings > API 中复制 Project URL 和 `anon` public key，填入 `collaboration-config.js`。
5. 提交并推送到 `main`，等待 GitHub Pages 发布。

未填写云端参数时，页面会继续使用浏览器本地存储，并明确显示“仅保存在当前浏览器”。

## 权限与并发

- 未登录用户可查看共享规划和接收实时更新。
- 登录用户可调整顺序和日期。
- 每次保存使用数据库版本号进行乐观锁校验；发生并发更新时，不同字段会自动合并后重试。
- 数据库拒绝越界日期、重复主题 ID 和匿名写入。

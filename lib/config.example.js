// 七牛云同步配置模板。
// 使用方法：复制本文件为 lib/config.js，填入你自己的七牛密钥。
//   - lib/config.js 已被 .gitignore 排除，不会入库
//   - 全部留空也可正常运行：扩展进入「仅本地」模式，笔记只存浏览器本地，
//     之后随时可在扩展设置页（右键工具栏图标 → 选项）补填密钥开启云同步
// 密钥获取：七牛云控制台 → 个人中心 → 密钥管理
export const DEFAULT_SETTINGS = {
  ak: '',
  sk: '',
  bucket: '',
  domain: '',     // 空间域名，如 xxxx.clouddn.com（测试域名 HTTPS 证书不匹配，代码内固定走 http）
  region: 'z2',   // 上传区域：z0 华东 / z1 华北 / z2 华南 / na0 北美 / as0 东南亚
};

// 「文章」阅读功能文章来源：七牛的另一个空间（与笔记同步同一个七牛账号、同一套 AK/SK）。
// 不使用文章阅读可留空占位。
export const VIDEO2NOTE = {
  bucket: '',
  domain: '',
  prefix: '',
  listHost: 'https://rsf.qiniuapi.com',
};

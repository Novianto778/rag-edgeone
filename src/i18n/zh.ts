const zh = {
  // App header
  "app.title": "企业 RAG Agent",
  "app.subtitle": "基于企业知识库的可追溯问答",

  // Knowledge Base Summary
  "kb.title": "知识库",
  "kb.documents": "文档",
  "kb.pages": "页面",
  "kb.dataSize": "数据大小",
  "kb.indexed": "已索引",
  "kb.entries": "条目",
  "kb.retry": "重试",

  // RagChat
  "chat.title": "知识查询",
  "chat.newSession": "新会话",
  "chat.loadingHistory": "正在加载对话历史...",
  "chat.emptyTitle": "询问你的知识库",
  "chat.emptyDesc": "查询文档，支持完整引用追溯",
  "chat.placeholder": "输入关于文档的问题...",
  "chat.streaming": "检索并生成中...",
  "chat.stop": "停止",
  "chat.you": "你",
  "chat.agent": "Agent",
  "chat.error": "请求失败，请检查后端服务是否正常运行。",
  "chat.stopped": "⏹ *已停止生成*",

  // Preset questions
  "preset.1": "EdgeOne Makers 提供的 context.store 是什么？",
  "preset.2": "EdgeOne Makers 的文件路由规则是什么？",

  // Citation
  "citation.badge": "已验证来源",
  "citation.id": "ID:",
  "citation.range": "范围:",
  "citation.chars": "字符数:",
  "citation.page": "第 {n} 页",
  "citation.expand": "展开",
  "citation.collapse": "收起",
  "citation.unknownDoc": "未知文档",

  // Aria labels
  "aria.refreshStats": "刷新统计",
  "aria.clearConversation": "清空会话",
  "aria.copyContent": "复制内容",

  // Language toggle
  "lang.switch": "English",

  // Tabs navigation
  "nav.documents": "文档与知识库",
  "nav.chat": "AI 问答",

  // Document Upload & Management
  "upload.title": "上传与索引文档",
  "upload.dragDrop": "拖拽 PDF 或 DOCX 文件至此处，或点击浏览文件",
  "upload.browse": "选择文件",
  "upload.hint": "支持 PDF 和 DOCX 格式。上传后将自动解析为 Markdown 并完成分块与向量索引。",
  "upload.status.ready": "已准备就绪",
  "upload.status.parsing": "解析中 (Firecrawl)...",
  "upload.status.chunking": "父子分块中...",
  "upload.status.embedding": "向量化中...",
  "upload.status.indexing": "Qdrant 索引中...",
  "docs.catalog": "知识库文档目录",
  "docs.empty": "暂无已索引文档。请上传 PDF/DOCX 文件。",

  // Floating links
  "floatingLink.deploy": "一键部署",
  "floatingLink.github": "GitHub",
} as const;

export default zh;

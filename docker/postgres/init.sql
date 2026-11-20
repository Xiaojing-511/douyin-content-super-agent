-- 向量扩展先装上，避免以后第一次写入方法卡时再改初始化脚本。
-- 当前消息表不使用向量列。该脚本只在数据卷为空的首次启动时执行。
CREATE EXTENSION IF NOT EXISTS vector;

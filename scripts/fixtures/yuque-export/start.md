# 面试笔记（语雀导出样例）
## 线程池
<font style="color:rgb(0, 0, 0);">线程池的好处：</font>

1. <font style="color:rgb(0, 0, 0);">降低资源消耗</font>
2. <font style="color:rgb(0, 0, 0);">提高响应速度</font>

3. ThreadPoolExecutor 4大核心参数
+ **<font style="color:rgba(0, 0, 0, 0.95) !important;">corePoolSize</font>**<font style="color:rgb(0, 0, 0);">：常驻线程</font>
+ **<font style="color:rgba(0, 0, 0, 0.95) !important;">maximumPoolSize</font>**<font style="color:rgb(0, 0, 0);">：最大线程数</font>
+ **<font style="color:rgba(0, 0, 0, 0.95) !important;">workQueue</font>**<font style="color:rgb(0, 0, 0);">：阻塞队列</font>

## 事务
1. **<font style="color:rgb(0, 0, 0);">原子性</font>**<font style="color:rgb(0, 0, 0);">  
</font><font style="color:rgb(0, 0, 0);">要么全部成功，要么全部失败。  
</font><font style="color:rgb(0, 0, 0);">例如转账。</font>
2. **<font style="color:rgb(0, 0, 0);">持久性</font>**<font style="color:rgb(0, 0, 0);">  
</font><font style="color:rgb(0, 0, 0);">提交后永久保存。</font>

## MVCC
1. **<font style="color:rgb(0, 0, 0);">隐藏字段</font>**

<font style="color:rgb(0, 0, 0);">InnoDB 每行记录都有隐藏字段：</font>

    - `<font style="color:rgb(0, 0, 0);">trx_id</font>`<font style="color:rgb(0, 0, 0);">：最近一次修改的事务 ID</font>
    - `<font style="color:rgb(0, 0, 0);">roll_pointer</font>`<font style="color:rgb(0, 0, 0);">：指向 undo log</font>
2. **<font style="color:rgb(0, 0, 0);">undo log</font>**

<font style="color:rgb(0, 0, 0);">保存旧版本。</font>

## 淘汰策略
**<font style="color:rgb(0, 0, 0);">只对带过期时间的 key 淘汰</font>**

+ `<font style="color:rgb(0, 0, 0);">volatile-lru</font>`<font style="color:rgb(0, 0, 0);">：淘汰最近最少使用</font>
+ `<font style="color:rgb(0, 0, 0);">volatile-ttl</font>`<font style="color:rgb(0, 0, 0);">：淘汰即将过期的 key</font>

结尾段落。

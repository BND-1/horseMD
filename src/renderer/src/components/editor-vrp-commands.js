// Huawei VRP command + snippet table for the `vrp` code-block language.
//
// Pure data and pure helpers only — no CodeMirror imports — so
// `scripts/test-vrp-language.mjs` can validate the table in plain Node (the
// completion wiring lives in editor-vrp-completions.js).
//
// Table rows are [label, group, info, insert?]:
//   - `label`  what the completion menu shows AND what the query matches, so it
//              stays a single ASCII token the user can type (`system-view`,
//              `vlan-access 模板`). The insert text may be much longer.
//   - `group`  menu detail column (视图 / 接口 / 路由 …).
//   - `info`   one-line Chinese description.
//   - `insert` optional document text; defaults to `label`. `«` / `»` mark the
//              placeholder that is selected after insertion (a lone `«` leaves
//              the caret there). A row may carry several pairs — the FIRST one
//              becomes the selection, the rest are inserted as plain text for
//              the user to tab to. Multi-line inserts are the "片段" (template)
//              rows at the end of the table.

export const VRP_COMMANDS = [
  // ---- 视图与基础 ----
  ['system-view', '视图', '从用户视图进入系统视图'],
  ['sysname «HOSTNAME»', '基础', '修改设备名（sysname 后接名称）'],
  ['quit', '视图', '退出当前视图，返回上一级'],
  ['return', '视图', '直接返回用户视图（等同 Ctrl+Z）'],
  ['save', '基础', '保存当前配置到下次启动配置'],
  ['display current-configuration', '基础', '查看当前生效的配置'],
  ['display saved-configuration', '基础', '查看下次启动使用的配置'],
  ['display version', '基础', '查看设备版本与运行时长'],
  ['display device', '基础', '查看单板与电源状态'],
  ['display clock', '基础', '查看系统时间'],
  ['reset saved-configuration', '基础', '清除下次启动配置（谨慎）'],
  ['reboot', '基础', '重启设备'],
  ['clock timezone «CST» add «08:00:00»', '基础', '设置时区'],
  ['header login information "«Welcome»"', '基础', '设置登录提示信息'],

  // ---- 接口 ----
  ['interface GigabitEthernet0/0/«1»', '接口', '进入千兆以太网接口'],
  ['interface XGigabitEthernet0/0/«1»', '接口', '进入万兆以太网接口'],
  ['interface Vlanif«10»', '接口', '进入 VLANIF 三层接口'],
  ['interface Eth-Trunk«1»', '接口', '进入链路聚合接口'],
  ['interface LoopBack«0»', '接口', '进入环回接口'],
  ['interface NULL0', '接口', '进入 NULL0 接口'],
  ['display interface brief', '接口', '查看接口物理状态概览'],
  ['display ip interface brief', '接口', '查看三层接口 IP 概览'],
  ['description «TO-CORE»', '接口', '接口描述'],
  ['undo shutdown', '接口', '开启（激活）接口'],
  ['shutdown', '接口', '关闭接口'],
  ['negotiation auto', '接口', '接口自协商'],
  ['duplex full', '接口', '设置全双工'],
  ['speed «1000»', '接口', '设置接口速率'],
  ['mtu «1500»', '接口', '设置接口 MTU'],
  ['ip address «192.168.1.1 255.255.255.0»', '接口', '配置接口 IP 与掩码'],
  ['ip address «192.168.1.1» «24»', '接口', '配置接口 IP（掩码长度写法）'],
  ['port link-type access', '接口', '接口设为 Access 模式'],
  ['port link-type trunk', '接口', '接口设为 Trunk 模式'],
  ['port link-type hybrid', '接口', '接口设为 Hybrid 模式'],
  ['port default vlan «10»', '接口', 'Access 口加入 VLAN'],
  ['port trunk allow-pass vlan «10 20»', '接口', 'Trunk 口放行 VLAN'],
  ['port trunk pvid vlan «1»', '接口', 'Trunk 口 PVID'],
  ['port hybrid untagged vlan «10»', '接口', 'Hybrid 口去标签放行'],
  ['port hybrid tagged vlan «10»', '接口', 'Hybrid 口带标签放行'],
  ['eth-trunk «1»', '接口', '将物理口加入链路聚合组'],
  ['mode lacp-static', '接口', '聚合组使用静态 LACP'],
  ['load-balance «src-dst-ip»', '接口', '聚合组负载分担方式'],
  ['port-isolate enable', '接口', '端口隔离'],
  ['stp edged-port enable', '接口', '配置为 STP 边缘端口'],
  ['bpdu enable', '接口', '开启接口 BPDU 收发'],

  // ---- VLAN ----
  ['vlan «10»', 'VLAN', '创建并进入 VLAN 视图'],
  ['vlan batch «10 20 30»', 'VLAN', '批量创建 VLAN'],
  ['name «OFFICE»', 'VLAN', '设置 VLAN 名称'],
  ['display vlan', 'VLAN', '查看 VLAN 及成员接口'],
  ['display mac-address', 'VLAN', '查看 MAC 地址表'],
  ['mac-vlan mac-address «0000-0000-0000» vlan «10»', 'VLAN', 'MAC 地址与 VLAN 绑定'],
  ['voice-vlan «10» enable', 'VLAN', '配置语音 VLAN'],
  ['dhcp snooping enable', 'VLAN', '开启 DHCP Snooping'],

  // ---- 路由 ----
  ['ip route-static «0.0.0.0 0.0.0.0 192.168.1.254»', '路由', '配置默认路由'],
  ['ip route-static «10.1.1.0 255.255.255.0 192.168.1.2»', '路由', '配置静态路由'],
  ['display ip routing-table', '路由', '查看 IP 路由表'],
  ['ospf «1» router-id «1.1.1.1»', '路由', '启动 OSPF 进程并指定 Router ID'],
  ['area «0»', '路由', '进入 OSPF 区域视图'],
  ['network «10.0.0.0» «0.0.0.255»', '路由', 'OSPF 宣告网段'],
  ['silent-interface «GigabitEthernet0/0/1»', '路由', 'OSPF 静默接口'],
  ['display ospf peer', '路由', '查看 OSPF 邻居'],
  ['bgp «65001»', '路由', '启动 BGP 并指定 AS 号'],
  ['peer «10.0.0.2» as-number «65002»', '路由', '配置 BGP 邻居 AS'],
  ['ipv4-family unicast', '路由', '进入 BGP IPv4 单播地址族'],
  ['peer «10.0.0.2» enable', '路由', '使能 BGP 邻居'],
  ['import-route «direct»', '路由', '引入直连/静态/OSPF 路由'],
  ['display bgp peer', '路由', '查看 BGP 邻居状态'],
  ['vrrp vrid «1» virtual-ip «192.168.1.254»', '路由', '配置 VRRP 虚拟 IP'],
  ['vrrp vrid «1» priority «120»', '路由', '配置 VRRP 优先级'],
  ['vrrp vrid «1» preempt-mode timer delay «20»', '路由', '配置 VRRP 抢占延时'],

  // ---- 安全 ----
  ['acl number «2000»', '安全', '创建基本 ACL'],
  ['acl number «3000»', '安全', '创建高级 ACL'],
  ['rule «5» permit source «192.168.1.0 0.0.0.255»', '安全', 'ACL 允许源网段'],
  ['rule «10» deny tcp destination-port eq «80»', '安全', 'ACL 拒绝指定端口'],
  ['traffic-filter inbound acl «3000»', '安全', '接口入方向应用 ACL'],
  ['firewall enable', '安全', '开启防火墙功能'],
  ['ip source-guard enable', '安全', '开启 IP 源防护'],

  // ---- 用户与登录 ----
  ['aaa', '用户', '进入 AAA 视图'],
  ['local-user «admin» password irreversible-cipher «PASSWORD»', '用户', '创建本地用户与密码'],
  ['local-user «admin» privilege level «15»', '用户', '设置本地用户级别'],
  ['local-user «admin» service-type «ssh telnet»', '用户', '设置本地用户可用服务'],
  ['user-interface vty 0 4', '用户', '进入 VTY 用户界面'],
  ['authentication-mode «aaa»', '用户', '配置登录认证方式'],
  ['protocol inbound «ssh»', '用户', 'VTY 允许的接入协议'],
  ['stelnet server enable', '用户', '开启 SSH 服务端'],
  ['rsa local-key-pair create', '用户', '生成本地 RSA 密钥对'],
  ['ssh user «admin» authentication-type password', '用户', '配置 SSH 用户认证方式'],
  ['telnet server enable', '用户', '开启 Telnet 服务端'],
  ['idle-timeout «10»', '用户', '配置登录超时时间'],

  // ---- 服务与系统 ----
  ['dhcp enable', '服务', '全局开启 DHCP'],
  ['ip pool «POOL1»', '服务', '创建全局地址池'],
  ['gateway-list «192.168.1.1»', '服务', '地址池网关'],
  ['network «192.168.1.0 mask 255.255.255.0»', '服务', '地址池可分配网段'],
  ['dns-list «8.8.8.8»', '服务', '地址池 DNS'],
  ['excluded-ip-address «192.168.1.1 192.168.1.10»', '服务', '地址池排除地址'],
  ['lease day «1»', '服务', '地址租期'],
  ['dhcp select global', '服务', '接口调用全局地址池'],
  ['ntp-service enable', '系统', '开启 NTP'],
  ['ntp-service unicast-server «10.0.0.1»', '系统', '指定 NTP 服务器'],
  ['snmp-agent', '系统', '开启 SNMP 代理'],
  ['snmp-agent sys-info version v2c', '系统', '设置 SNMP 版本'],
  ['snmp-agent community read cipher «PUBLIC»', '系统', '设置 SNMP 读团体字'],
  ['info-center enable', '系统', '开启信息中心'],
  ['display logbuffer', '系统', '查看日志缓冲区'],
  ['ping «192.168.1.1»', '系统', '测试连通性'],
  ['tracert «8.8.8.8»', '系统', '路由跟踪'],

  // ---- 配置片段（多行模板）----
  [
    'vlan-access 模板',
    '片段',
    'Access 接口 + VLAN 配置片段',
    'vlan batch «10»\n' +
      'interface GigabitEthernet0/0/«1»\n' +
      ' port link-type access\n' +
      ' port default vlan «10»\n' +
      ' undo shutdown\n' +
      ' quit'
  ],
  [
    'vlan-trunk 模板',
    '片段',
    'Trunk 上联口配置片段',
    'interface GigabitEthernet0/0/«24»\n' +
      ' description «TO-SWITCH»\n' +
      ' port link-type trunk\n' +
      ' port trunk allow-pass vlan «10 20»\n' +
      ' undo shutdown\n' +
      ' quit'
  ],
  [
    'vlanif 模板',
    '片段',
    'VLANIF 三层接口配置片段',
    'interface Vlanif«10»\n' +
      ' description «GATEWAY-VLAN10»\n' +
      ' ip address «192.168.10.1 255.255.255.0»\n' +
      ' quit'
  ],
  [
    'static-route 模板',
    '片段',
    '默认路由 + 静态路由片段',
    'ip route-static «0.0.0.0 0.0.0.0 192.168.1.254»\n' +
      'ip route-static «10.1.1.0 255.255.255.0 192.168.1.2»'
  ],
  [
    'ospf 模板',
    '片段',
    'OSPF 单区域基础配置片段',
    'ospf «1» router-id «1.1.1.1»\n' +
      ' area «0»\n' +
      '  network «10.0.0.0» «0.0.0.255»\n' +
      ' quit\n' +
      ' quit'
  ],
  [
    'ssh 模板',
    '片段',
    'SSH 登录（VTY + AAA 用户）配置片段',
    'stelnet server enable\n' +
      'rsa local-key-pair create\n' +
      'aaa\n' +
      ' local-user «admin» password irreversible-cipher «PASSWORD»\n' +
      ' local-user «admin» privilege level «15»\n' +
      ' local-user «admin» service-type ssh\n' +
      ' quit\n' +
      'user-interface vty 0 4\n' +
      ' authentication-mode aaa\n' +
      ' protocol inbound ssh\n' +
      ' quit'
  ],
  [
    'acl 模板',
    '片段',
    '高级 ACL 拦截 + 接口应用片段',
    'acl number «3000»\n' +
      ' rule «5» deny tcp destination-port eq «80»\n' +
      ' rule «10» permit ip\n' +
      ' quit\n' +
      'interface GigabitEthernet0/0/«1»\n' +
      ' traffic-filter inbound acl «3000»\n' +
      ' quit'
  ],
  [
    'dhcp 模板',
    '片段',
    '全局地址池 DHCP 配置片段',
    'dhcp enable\n' +
      'ip pool «POOL1»\n' +
      ' gateway-list «192.168.1.1»\n' +
      ' network «192.168.0.0 mask 255.255.0.0»\n' +
      ' dns-list «8.8.8.8»\n' +
      ' excluded-ip-address «192.168.1.1 192.168.1.10»\n' +
      ' lease day «1»\n' +
      ' quit\n' +
      'interface Vlanif«10»\n' +
      ' dhcp select global\n' +
      ' quit'
  ]
]

const OPEN_MARK = '«'
const CLOSE_MARK = '»'

// The marker pair is an insert-time convention; the menu shows the plain text.
export function vrpLabelDisplay(label) {
  return String(label).split(OPEN_MARK).join('').split(CLOSE_MARK).join('')
}

// The marker pair is the only transformation applied; every other character
// (including a pasted `display` output inside a snippet) stays verbatim.
export function vrpSnippetText(insert) {
  return String(insert).split(OPEN_MARK).join('').split(CLOSE_MARK).join('')
}

// Selection to apply after inserting `insert` at document offset `from`: the
// FIRST placeholder text if a pair is balanced, just the caret otherwise. Later
// placeholder pairs (multi-parameter commands) are inserted as plain text.
export function vrpSnippetSelection(insert, from) {
  const text = String(insert)
  const open = text.indexOf(OPEN_MARK)
  if (open === -1) return { anchor: from + vrpSnippetText(text).length }
  const close = text.indexOf(CLOSE_MARK, open + 1)
  const anchor = from + open
  if (close === -1) return { anchor }
  return { anchor, head: from + close - 1 }
}

// First ASCII token of a label — the part a user can actually type. Chinese
// template labels still carry a typeable prefix (`vlan-access 模板`).
export function vrpLabelToken(label) {
  const match = String(label).match(/^[A-Za-z][\w-]*/)
  return match ? match[0].toLowerCase() : ''
}

// Query filtering: prefix match on the label's first token wins; when nothing
// matches by prefix, fall back to a substring match anywhere in the label (so
// «.1» still finds `ip address 192.168.1.1 255.255.255.0`). An empty query
// (Ctrl+Space) returns the whole table.
export function filterVrpCommands(query) {
  const q = String(query == null ? '' : query).toLowerCase()
  if (!q) return VRP_COMMANDS
  const starts = VRP_COMMANDS.filter((row) => vrpLabelToken(row[0]).startsWith(q))
  if (starts.length) return starts
  return VRP_COMMANDS.filter((row) => String(row[0]).toLowerCase().includes(q))
}

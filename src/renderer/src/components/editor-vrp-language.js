// Huawei VRP (Versatile Routing Platform) syntax for the Milkdown/Crepe code
// block: the `vrp` fence language, plus the VRP command snippets that go with it.
//
// Why a hand-written StreamLanguage: VRP configuration has no published
// CodeMirror language package and @codemirror/legacy-modes ships no VRP mode.
// VRP config is line-oriented — `#` comments, `system-view`/`interface …` views,
// `[Huawei-GigabitEthernet0/0/1]` prompts, `IP/mask`, interface names and
// `undo …` verbs — so a compact tokenizer covers real runbook snippets without
// pulling in a grammar.
//
// Integration channel (both are supported channels, no prototype patching):
//   - `vrpLanguage` is appended to `codeBlockConfig.languages` in
//     editor-crepe-setup.js — the same list Crepe's CodeMirror language picker
//     reads. Milkdown's LanguageLoader resolves a fence info string against the
//     descriptor `alias` entries ONLY (hence 'vrp' must be an alias), while the
//     picker writes the descriptor `name` back into the code_block attribute —
//     both spellings resolve to this descriptor.
//   - Command completions ride this language's LanguageSupport, so the snippet
//     menu only opens inside VRP blocks. The completion module is a dynamic
//     import: documents without a VRP block never parse it (same lazy pattern
//     as the Mermaid import in editor-mermaid.js).

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'

// Command verbs / view names / configuration keywords, matched
// case-insensitively. Broad on purpose: a runbook snippet should never look
// "unhighlighted" because a rarer verb is missing.
const COMMANDS = new Set(
  (
    'system-view sysname quit return save display interface vlan vlanif vlan-batch port port-group eth-trunk ' +
    'ospf bgp isis rip acl rule nat dhcp dhcpv6 dns route-static ip ipv6 undo shutdown description address mask ' +
    'gateway mac-address stp bpdu lldp ntp ntp-service snmp-agent ssh stelnet telnet user-interface console vty ' +
    'aaa local-user password privilege level service-type authentication authorization accounting ftp tftp sftp scp ' +
    'info-center logbuffer header clock timezone reboot reset ping tracert commit backup startup saved-configuration ' +
    'current-configuration configuration https http server enable disable permit deny source destination time-range ' +
    'ip-pool lease excluded-ip-address static-bind vrrp vrid virtual-ip priority preempt track bfd mstp region ' +
    'instance link-type trunk access hybrid tagged untagged pvid negotiation auto duplex speed flow-control poe ' +
    'mirror observe-port qos traffic classifier behavior policy car queue wred mpls lsp vpn-instance ipv4-family ' +
    'ipv6-family peer network import-route area cost timer silent-interface authentication-mode bandwidth mtu jumbo ' +
    'arp gratuitous-arp gratuitous-arp-send dhcp-snooping dot1x mac-vlan voice-vlan protocol-vlan ip-subnet-vlan ' +
    'aggregate-group link-aggregation lacp load-balance dad delay arp-proxy nd ra router-advertisement icmp ' +
    'tcp-adjust-mss firewall zone security-policy nat-policy address-set service-set syslog trap community version ' +
    'read write notify interval slot card sub cpu memory temperature fan power interface-range port-isolate isolated ' +
    'uplink dns-list domain-name option tftp-server next-server bootfile vendor-class-identifier ip-address-pool ' +
    'route-policy apply match as-path-filter community-filter ip-prefix-filter peer-group reflect-client ' +
    'next-hop-local route-reflector peer-as remote-as timers keepalive hold mapping vlan-mapping protected-vlan ' +
    'mac-forced-forwarding arp-detection ip-source-guard trust option82 ipv6-enable ipv6-address prefix-length ' +
    'link-local ra-mtu ra-hop-limit id source-guard reauth edg-port port-security sticky-mac mode lacp-static ' +
    'irf mad bfd-session smart-link monitor-link dldp efm cfm y1731'
  ).split(/\s+/)
)

// Parameter values and states — the words that are not commands but should not
// read as free-form identifiers either.
const PARAMS = new Set(
  (
    'up down enable disable enabled disabled on off yes no true false any all inbound outbound both inside outside ' +
    'tcp udp icmp icmpv6 gre esp ah master slave primary secondary active standby first second preferred accept ' +
    'drop forward deny permit untagged tagged hybrid access trunk auto half full direct static ospf bgp rip isis ' +
    'unicast multicast global local cipher simple irreversible-cipher plain md5 sha1 sha2 hmac-sha2-256 hmac-sha2-512 ' +
    'ssh telnet http https snmp ftp sftp aaa none password key rsa dsa ecc v2c v3 src-dst-ip src-ip dst-ip ' +
    'src-dst-mac enhanced normal loose strict always never low medium high highest lowest common critical major ' +
    'minor warning informational debugging emergency alert error notice'
  ).split(/\s+/)
)

const PROMPT_RE = /^[\[<][^\]>\n]{0,80}[\]>]/
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?/
const MAC_RE = /^(?:[0-9a-f]{4}[-.]){2,}[0-9a-f]{4}\b|^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i
const INTERFACE_RE =
  /^(?:XGigabitEthernet|GigabitEthernet|FastEthernet|Ethernet|Eth-Trunk|25GE|40GE|100GE|10GE|GE|Eth|Vlanif|Vlan-interface|LoopBack|Loopback|Tunnel|Serial|MEth|NULL|Virtual-Template|Mp-group|Wlan-Ess|Cellular|Vbdif|Nve)[\d/.:_-]*/i
const STRING_RE = /^"(?:[^"\\\n]|\\.)*"?|^'(?:[^'\\\n]|\\.)*'?/
const NUMBER_RE = /^\d+(?:\.\d+)?%?/
const WORD_RE = /^[A-Za-z_][\w-]*/
const BRACKET_RE = /[{}()[\]]/
const OPERATOR_RE = /[|&<>!=+*/]/

// Legacy-mode style tokenizer. CodeMirror calls it repeatedly per line; every
// branch must consume at least one character, and the end-of-line fallback
// (`peek() === undefined`) must never fall through to the word branch —
// `RegExp.test(undefined)` matches the literal string "undefined".
const vrpStreamParser = {
  token(stream) {
    if (stream.eatSpace()) return null
    const ch = stream.peek()
    if (ch === undefined) {
      stream.next()
      return null
    }
    if (ch === '#') {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match(PROMPT_RE)) return 'meta'
    if (stream.match(IPV4_RE) || stream.match(MAC_RE)) return 'atom'
    if (stream.match(INTERFACE_RE)) return 'typeName'
    if (ch === '"' || ch === "'") {
      stream.match(STRING_RE)
      return 'string'
    }
    if (BRACKET_RE.test(ch)) {
      stream.next()
      return 'bracket'
    }
    if (OPERATOR_RE.test(ch)) {
      stream.next()
      return 'operator'
    }
    if (ch >= '0' && ch <= '9') {
      stream.match(NUMBER_RE)
      return 'number'
    }
    const word = stream.match(WORD_RE)
    if (word) {
      const lower = word[0].toLowerCase()
      if (COMMANDS.has(lower)) return 'keyword'
      if (PARAMS.has(lower)) return 'atom'
      return 'variableName'
    }
    // Non-ASCII text (Chinese descriptions, full-width punctuation) and any
    // other character: consume one and emit no token.
    stream.next()
    return null
  }
}

export const vrpStreamLanguage = StreamLanguage.define(vrpStreamParser)

// `name` is what the picker shows and writes into the code block; `alias` is
// what the fence info string and the query are matched against — 'vrp' has to
// be in both spellings (see the header note).
export const vrpLanguage = LanguageDescription.of({
  name: 'VRP',
  alias: ['vrp', 'huawei', 'vrpcfg', 'vrp-config'],
  extensions: ['vrp', 'cfg'],
  async load() {
    const { vrpCompletionExtension } = await import('./editor-vrp-completions.js')
    return new LanguageSupport(vrpStreamLanguage, [vrpCompletionExtension])
  }
})

// Guard against CM API drift (mirrors editor-codeblock-tab.js / -eager.js): if a
// future bump renames the StreamLanguage factory, surface it instead of silently
// shipping a language that never highlights.
if (typeof StreamLanguage?.define !== 'function' || typeof LanguageDescription?.of !== 'function') {
  // eslint-disable-next-line no-console
  console.warn('[horsemd] VRP language: @codemirror/language API changed — vrp highlighting may be gone.')
}

# Self and inclusive time per function of a Chrome .cpuprofile (ms).
# usage: python3 scripts/perf/cpuprofile-summary.py <file.cpuprofile>
import json,sys,collections
p=json.load(open(sys.argv[1]))
nodes={n['id']:n for n in p['nodes']}
self=collections.Counter()
dt=p['timeDeltas']; samples=p['samples']
for sid,d in zip(samples,dt): self[sid]+=d
# total (inclusive) via parent map
parent={}
for n in p['nodes']:
  for c in n.get('children',[]): parent[c]=n['id']
incl=collections.Counter()
for sid,t in self.items():
  seen=set(); x=sid
  while x is not None:
    cf=nodes[x]['callFrame']; key=(cf['functionName'] or '(anon)', cf['url'].split('/')[-1], cf['lineNumber'])
    if key not in seen: incl[key]+=t; seen.add(key)
    x=parent.get(x)
byself=collections.Counter()
for sid,t in self.items():
  cf=nodes[sid]['callFrame']; byself[(cf['functionName'] or '(anon)', cf['url'].split('/')[-1], cf['lineNumber'])]+=t
tot=sum(self.values())/1000
print('total ms',round(tot))
print('--- self'); [print(round(t/1000),k) for k,t in byself.most_common(25)]
print('--- inclusive'); [print(round(t/1000),k) for k,t in incl.most_common(140)]

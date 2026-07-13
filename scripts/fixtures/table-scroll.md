# Table scroll regression

The first table should fit the writing area without a horizontal scrollbar.

| Name | Value |
| --- | --- |
| Alpha | Short content |
| Beta | Another short value |

The second table should keep readable columns and scroll horizontally.

| Product | Platform | Installation path | Configuration location | Update channel | Workspace behavior | Export behavior | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HorseMD Desktop | macOS, Windows, and Linux | A deliberately longer installation path for layout testing | User settings and application preferences | Stable release with automatic update checks | Multiple folder roots can be active in one workspace | Markdown, HTML, and configurable PDF output | This deliberately long sentence must wrap within a readable column instead of squeezing every character vertically. |
| HorseMD Mobile | iOS and Android | Application sandbox and local document provider | Shared renderer settings | Manual package or store update | Local folders exposed by the operating system | Share sheet and local file export | Swipe this table horizontally on a narrow screen. |

Raw HTML tables use the same overflow behavior.

<table>
  <thead><tr><th>Column A</th><th>Column B</th><th>Column C</th><th>Column D</th><th>Column E</th><th>Column F</th><th>Column G</th><th>Column H</th></tr></thead>
  <tbody><tr><td>Readable content</td><td>Longer HTML table content</td><td>More content</td><td>More content</td><td>More content</td><td>More content</td><td>More content</td><td>Last column remains reachable</td></tr></tbody>
</table>

End marker.

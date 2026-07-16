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

The third table is both tall and wide. Its row and column controls must remain
inside the editor viewport after the header has scrolled away.

| Rank | Product ID | Product description | Price | Coupon | Sales | Commission |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 1 | 46232520 | A deliberately long product description that wraps over multiple lines in a readable column. | 34.2 | 117 | 100 | 20.05% |
| 2 | 46230985 | Another long description keeps this regression table tall enough to scroll its header away. | 35.9 | 0 | 200 | 20% |
| 3 | 46234518 | Long educational product title with several words and enough content to wrap naturally. | 6.8 | 5 | 100 | 65% |
| 4 | 46228535 | Breakfast product bundle with a longer descriptive title for table layout testing. | 13.95 | 104 | 100 | 20% |
| 5 | 46230582 | Household paper product with package size and usage details in the description. | 23.42 | 0 | 100 | 15% |
| 6 | 46234329 | Shampoo product description covering several visible features and intended usage. | 49.9 | 218 | 200 | 20% |
| 7 | 46232212 | Family tissue multipack with a long title that increases the rendered row height. | 30.27 | 0 | 100 | 10% |
| 8 | 46231979 | Summer hair-care product with cleansing and refreshing properties in its title. | 49 | 47 | 100 | 25.5% |
| 9 | 46230634 | Toothpaste family bundle whose full description wraps across multiple lines. | 29.8 | 67 | 100 | 18% |
| 10 | 46232754 | Larger personal-care bundle used as the final row of the tall table fixture. | 89 | 151 | 200 | 15% |

Raw HTML tables use the same overflow behavior.

<table>
  <thead><tr><th>Column A</th><th>Column B</th><th>Column C</th><th>Column D</th><th>Column E</th><th>Column F</th><th>Column G</th><th>Column H</th></tr></thead>
  <tbody><tr><td>Readable content</td><td>Longer HTML table content</td><td>More content</td><td>More content</td><td>More content</td><td>More content</td><td>More content</td><td>Last column remains reachable</td></tr></tbody>
</table>

End marker.

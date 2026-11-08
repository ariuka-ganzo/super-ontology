# Explore: a relationship graph that finds insights for you

Design for Super Ontology v0.3. Dashboards answer questions you already have. Explore is for questions you do not know to ask yet: it shows how the things in your data connect, how strongly, how that changes over time, and points at what is unusual.

## What the leading tools do

| Tool                                                                      | Idea worth taking                                                                                                                                   | Gap for a desktop analyst                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Palantir Foundry Ontology and Object Explorer                             | Tables become **object types**, rows become **objects**, columns become **properties**, joins become **links**. People explore objects, not tables. | Needs a platform team to model the ontology first.                          |
| Palantir Vertex                                                           | Build a graph by "searching around" from an object, filter it with histograms, and read **time series** for each object; quantify cause and effect. | Enterprise-only; time series are a separate setup.                          |
| Palantir Quiver                                                           | Time series and events analysed next to the objects they belong to.                                                                                 | Separate tool from the graph.                                               |
| Obsidian graph view                                                       | A force-directed map you can hover and focus; neighbours light up and everything else fades. Fast and calm.                                         | Shows only that a link exists, never how big or how surprising it is.       |
| Neo4j Bloom, Linkurious, Graphistry, Kumu                                 | Visual graph exploration, grouping, styling by property, very large graphs on the GPU (Graphistry).                                                 | Need a graph database or graph-shaped data, and give no automatic insights. |
| Power BI Key Influencers, Decomposition Tree; Tableau Explain Data, Pulse | Automatically name the **drivers** of a value and flag spikes, dips and trends.                                                                     | Each works on one chart at a time; none shows the web of relationships.     |

Sources: Palantir docs for [the Ontology](https://palantir.com/docs/foundry/learning-application-ontology-01/04), [Vertex object relationships](https://palantir.com/docs/foundry/vertex/explore-object-relationships/), [Vertex time series](https://palantir.com/docs/foundry/vertex/explore-time-series/) and [events](https://www.palantir.com/docs/foundry/vertex/events-overview); [Neo4j's graph visualization overview](https://neo4j.com/blog/graph-visualization/neo4j-graph-visualization-tools); [Linkurious vs Bloom](https://linkurious.com/blog/linkurious-enterprise-neo4j-bloom/); [Tableau Pulse vs Key Influencers](https://theinformationlab.co.uk/community/blog/exploring-analytical-insights-tableau-pulse-vs-power-bi-key-influencers); [sigma.js](https://sigmajs.org).

No single tool joins the three things together: an ontology graph of your own tables, values and time on that graph, and automatic, explained insights. That combination is the goal.

## First principles

1. **Data is things, connections, amounts and time.** Every table already says which things (a customer, a product, a region) took part in each row, how much (sales, units) and when. Two things are connected when they appear in the same rows. So a relationship graph can be derived from any table and the model's joins, with no separate graph database or modelling step.
2. **An insight is a gap between what you expected and what happened.** If East is 30% of sales and Furniture is 20%, then "East and Furniture" should be about 6% if they were unrelated. If it is 14%, that is a hidden relationship. The same idea covers outliers (far from the typical value), movers (far from last period), spikes (far from the usual level), and concentration (far from an even spread). Insights should be ranked by how big the gap is and how much it matters, and each must say in plain words why it was flagged.
3. **People see structure, not numbers.** Size, colour, closeness and thickness are read instantly; tables are read slowly. Put amounts on the nodes (size), surprise on the links (colour and thickness), and change on the nodes (colour mode). Numbers appear on demand, on hover and in the side panel.
4. **A graph of everything is a hairball.** Readable graphs have hundreds of nodes, not hundreds of thousands. So nodes are the **values that matter** (the top values of each chosen field), and links are the **strongest and most surprising** connections, not every pair. Detail comes from drilling in, not from drawing more.
5. **Time is a dimension of every value.** Each node carries its own series. A timeline lets you pick a window; the graph shows that window and how it differs from the window before it. Playing through time shows relationships forming and fading.
6. **Speed comes from doing less, earlier.** The engine (DuckDB) does every aggregation, and only a few hundred numbers cross into the window. Drawing uses WebGL. Hover and selection change styles in memory without re-querying. Changing the time window runs a handful of small queries, cached by window.

## The design

### The graph

- You pick 2 to 6 **fields** (for example region, category, segment, customer) from any tables, a **measure** (for example sum of sales, or row count) and a **date** field. Explore suggests a starting set.
- **Nodes** are the top values of each field (default 30), sized by the measure and coloured by field. Fields from different tables connect through the model's relationships, so this is an ontology view: customers link to the products they bought, through orders.
- **Links** join values of different fields that occur together. Each link has a **strength** (its share of the measure) and a **lift**: how many times more (or less) often the pair occurs than if the two were unrelated. Lift above 1 is drawn in the accent colour, below 1 in red, and thickness follows strength. A control chooses which links to draw: the most surprising, the strongest, or both, so the picture stays readable.
- **Layout** is force-directed (ForceAtlas2), so values that share many strong links pull together and clusters appear by themselves, as in Obsidian.
- **Hover** lights up a node's neighbours and fades the rest. **Click** selects a node and opens its details. **Double-click** focuses on its neighbourhood. **Search** finds a value and flies to it. **Colour by change** switches node colours to growth (green) or decline (red) against the previous window.

### Insights, ranked and explained

An insight panel lists findings across the whole graph, most important first. Each one names its evidence in words and numbers, and clicking it highlights the nodes and links involved.

- **Hidden link**: a pair that occurs much more often than expected (lift well above 1), weighted by its size so tiny coincidences do not rank.
- **Avoided pair**: two large values that rarely occur together (lift well below 1).
- **Mover**: the values that grew or shrank most compared with the previous window.
- **Shifting link**: a link whose lift changed most between windows.
- **Outlier**: a value far above the typical value of its field (robust z-score using the median and the median absolute deviation).
- **Spike or dip**: a period in a value's series far from its usual level.
- **Concentration**: when a few values hold most of the measure (for example "the top 3 customers are 41% of sales").

### A value's own story

Selecting a node shows its amount and share, its series over time with the selected window marked, its change, and **what makes it different**: for each other field, the values it is over- and under-represented in compared with everything else ("East buys Furniture 2.3 times more than average"). This is the Key Influencers idea applied to any node, and it is computed from links that are already loaded, so it is instant.

### The timeline

A strip along the bottom shows the measure over time. Drag to choose a window, or press play to step through periods. The graph, its links and the insights follow the window, comparing it with the window just before. Node positions are kept as the window moves, so change is visible as growth, shrinkage and links appearing or fading, not as a re-shuffled picture.

### Speed targets

- Hover, select and focus: within one frame (they only restyle what is drawn).
- Build a graph or move the time window: well under a second for the sample project, and a few hundred milliseconds of engine time for a million rows. Queries run in parallel and results are cached per window.
- Layout runs in small slices between frames, so the window never freezes while the graph settles.

### How it fits the app

- A new **Explore** item in the sidebar. Explorations are saved in the project (format version 3).
- All queries go through the existing compiler, so model relationships, data source filters and cleaning steps apply, and values are always bound parameters.
- From a node, **Open in worksheet** creates a worksheet with that value's trend, to take a finding into a dashboard.

### Not in this version

Object-level graphs of individual rows (every order as a node), what-if simulation, and AI-written narratives. The design leaves room for each.

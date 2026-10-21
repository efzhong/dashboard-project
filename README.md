https://efzhong.github.io/dashboard-project/streetlights/

This tool helps to search a Philadelphia address to find the nearest city-owned streetlights, or alley lights (different agency than Streets for repairs). The side panel shows whether each light has a street or alley light outage report open with Philly311 and what the department's status notes say. It also shows how long the report has been open compared with the Streets Department's 10-business-day repair goal, along with where to report or follow up. Also included are a ranked list and shaded map to show which council districts have filed the most light outage reports over the past year. 

Its intended users are Philadelphia residents who want to know if outages have already been reported, status, and who to contact. Neighborhood groups or planners in council district offices could also utilize this to look for areas where outages pile up or stay open past the repair goal.

It should help people asking: 
Should I file a new 311 report, or follow up on an open one and with which agency?
Which council districts and blocks may need attention from the City, based on report volume and overdue repairs?

I used 311 reports from the Philly311 Carto SQL API ("Light Outage"): status, status_notes, agency_responsible, and dates. The map and district counts cover the past 365 days and each report is assigned to a district within 2024 council district boundaries.
The streetlights CSV of city-owned pole locations is compiled through my work-study with the City of Philadelphia in an ongoing project. Certain information has been omitted for that reason, only leaving pole ID and location. A 311 report has no pole ID, so it's matched to a pole by distance (100 ft by default, set in config.js). In dense blocks, one report could be any of several neighboring poles.
To answer the "what should I do?", I included the city's online request form and Philly311. 

Data sources:
City of Philadelphia, Philly311. 311 Service and Information Requests. OpenDataPhilly. https://opendataphilly.org/datasets/311-service-and-information-requests/
City of Philadelphia, Department of Planning and Development. City Council Districts (2024). OpenDataPhilly. (https://opendataphilly.org/datasets/city-council-districts/)]
City of Philadelphia. Report a problem with a street or alley light. https://www.phila.gov/services/streets-sidewalks-alleys/report-a-problem-on-a-city-street-sidewalk-or-alley/report-a-problem-with-a-street-or-alley-light/
Address search © OpenStreetMap contributors, via Nominatim. Basemap © CARTO, © OpenStreetMap contributors.

I received assistance from Claude AI in several parts to troubleshoot and identify the best pathway to the web design I wanted (denoted by a comment in that section of code). This was built with MapLibre GL JS and Papa Parse.
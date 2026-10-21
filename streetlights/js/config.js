export const CONFIG = {
  poles: {
    csvPath: 'data/streetlights_psip.csv',
    id: 'City Pole Number',
    lat: 'Lat',
    lng: 'Lon',
  },

  // Council district boundaries, downloaded from OpenDataPhilly as GeoJSON, 2024 boundaries
  districtsPath: 'data/council_districts.geojson',
  districtField: null,

  // How far back to load 311 street/alley light outage reports for the map and district counts
  reportsSinceDays: 365,

  nearestCount: 5,

  // 311 reports are placed at the address the caller gave so any report within this distance of a pole counts
  matchRadiusFeet: 100,

  // Streets Department's goal for repairing a streetlight outage
  repairTargetBusinessDays: 10,

  // Who to contact
 
  contacts: [
    {
      match: 'streets',
      name: 'Philadelphia Streets Department',
      url: 'https://www.phila.gov/services/streets-sidewalks-alleys/report-a-problem-on-a-city-street-sidewalk-or-alley/report-a-problem-with-a-street-or-alley-light/',
      urlLabel: 'Street or alley light request form',
      email: 'ledstreetlighting@phila.gov',
    },
  ],
  defaultContact: {
    name: 'Philly311',
    url: 'https://www.phila.gov/departments/philly311/',
    urlLabel: 'Philly311',
    phone: '311 (or 215-686-8686 from outside Philadelphia)',
    email: '',
  },
};
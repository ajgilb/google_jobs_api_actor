# Google Jobs API Actor

This Apify actor uses the SearchAPI.io Google Jobs API to search for job listings, optionally finds company email addresses using Hunter.io, and saves the results to a dataset or pushes them to a database.

## Features

- Search for job listings using custom queries
- Filter by location
- Extract structured data including salary information, skills, and experience level
- Find company websites using SearchAPI.io
- Discover company email addresses using Hunter.io
- Save results to Apify dataset
- Option to push results to an external database
- Deduplication of job listings
- Filtering for fast food restaurants and recruiting agencies

## Input Parameters

- `queries` - List of search queries to run (e.g., "restaurant chef united states")
- `location` - Optional location filter (e.g., "New York")
- `maxPagesPerQuery` - Maximum number of pages to fetch per query
- `saveToDataset` - Whether to save results to Apify dataset
- `pushToDatabase` - Whether to push results to external database
- `databaseUrl` - URL of the external database
- `databaseTable` - Name of the database table to insert jobs into
- `deduplicateJobs` - Whether to check for and skip duplicate jobs when pushing to database
- `useTopCities` - If true, expands each query across a built-in list of major US cities
- `cities` - Optional custom list of cities (e.g., ["New York NY", "Los Angeles CA"]). If provided, overrides top cities
- `fullTimeOnly` - Whether to filter for full-time positions only
- `excludeFastFood` - Whether to exclude fast food restaurants
- `excludeRecruiters` - Whether to exclude recruiting agencies
- `includeHunterData` - Whether to include email addresses from Hunter.io (enabled by default)

## Output

The actor outputs job listings with the following structure:

```json
{
  "title": "Executive Chef",
  "company": "Restaurant Group",
  "location": "New York, NY",
  "posted_at": "2 days ago",
  "schedule": "Full-time",
  "description": "Job description...",
  "salary_min": 75000,
  "salary_max": 90000,
  "salary_currency": "USD",
  "salary_period": "yearly",
  "skills": ["cooking", "menu planning", "kitchen management"],
  "experience_level": "senior",
  "apply_link": "https://example.com/apply",
  "source": "LinkedIn",
  "scraped_at": "2023-05-15T12:34:56.789Z",
  "company_website": "https://restaurantgroup.com",
  "company_domain": "restaurantgroup.com",
  "emails": [
    {
      "email": "chef@restaurantgroup.com",
      "firstName": "John",
      "lastName": "Doe",
      "position": "Executive Chef",
      "confidence": 80,
      "_originalCompany": "Restaurant Group",
      "_originalDomain": "restaurantgroup.com"
    }
  ]
}
```

## Usage

1. Set up your API keys in the environment variables:
   ```
   SEARCH_API_KEY=your_searchapi_key_here
   HUNTER_API_KEY=your_hunter_key_here
   ```

2. Configure the input parameters according to your needs.

   Example to run city-by-city across top US cities:

   ```json
   {
     "queries": [
       "restaurant chef jobs",
       "restaurant manager jobs"
     ],
     "useTopCities": true,
     "maxPagesPerQuery": 20
   }
   ```

   Example to run against a custom set of cities:

   ```json
   {
     "queries": ["restaurant chef jobs"],
     "cities": ["New York NY", "Los Angeles CA", "Chicago IL"],
     "maxPagesPerQuery": 20
   }
   ```

3. Run the actor and retrieve the results from the dataset.

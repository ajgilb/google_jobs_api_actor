/**
 * Bing Search API integration for job listings via SearchAPI.io
 * Searches for job listings using Bing search and extracts job information
 */

/**
 * List of domains to exclude from job search results
 * These are major job boards and sites that aggregate jobs rather than direct employers
 */
const EXCLUDED_JOB_DOMAINS = [
    // Major Job Boards (Indeed removed to allow Indeed listings)
    'linkedin.com', 'glassdoor.com', 'ziprecruiter.com',
    'monster.com', 'careerbuilder.com', 'simplyhired.com', 'snagajob.com',
    'joblist.com', 'jobrapido.com', 'ihirechefs.com', 'chefjobsnetwork.com',
    
    // Recruiting/Staffing Sites
    'randstad.com', 'adecco.com', 'manpower.com', 'kellyservices.com',
    'robertwalters.com', 'hays.com', 'michaelpage.com',
    
    // General directories and listing sites
    'yellowpages.com', 'whitepages.com', 'superpages.com',
    'manta.com', 'bbb.org', 'yelp.com', 'google.com',

    // Fast food chains (excluded to focus on professional culinary positions)
    'mcdonalds.com'
];

/**
 * List of company names to exclude from job search results
 * These are job boards, recruiting companies, and aggregators that appear as company names
 */
const EXCLUDED_COMPANY_NAMES = [
    // Job Boards (as company names)
    'indeed', 'linkedin', 'glassdoor', 'ziprecruiter', 'monster', 'careerbuilder',
    'simplyhired', 'snagajob', 'job.com', 'ladders', 'getwork', 'bebee',
    'diversityjobs', 'ihirechefs', 'chefjobsnetwork', 'hcareers',

    // Recruiting/Staffing Companies
    'aramark', 'robert half', 'roberthalf', 'randstad', 'adecco', 'manpower', 'kelly services',
    'kellyservices', 'robert walters', 'robertwalters', 'hays', 'michael page',
    'michaelpage', 'gecko hospitality', 'geckohospitality', 'hospitality confidential', 'hospitalityconfidential',

    // Craigslist variants (any domain or company name containing these)
    'craigslist', 'craiglist', 'craig list', 'craigs list', 'craig\'s list',
    'detroit.craigslist', 'newyork.craigslist', 'chicago.craigslist', 'losangeles.craigslist',

    // Other aggregators and job sites
    'culinary agents', 'hospitality online', 'chicagotribune', 'thechefagency',
    'the chef agency', 'maggianosjobs', 'flagshiprestaurantgroup', 'hrmdirect',

    // Fast food chains (excluded to focus on professional culinary positions)
    'mcdonalds', 'mcdonald\'s', 'mcdonald', 'mc donalds'
];

/**
 * Checks if a URL should be excluded from job search results
 * @param {string} url - The URL to check
 * @returns {boolean} - True if the URL should be excluded
 */
function shouldExcludeJobUrl(url) {
    if (!url) return false;

    const lowerUrl = url.toLowerCase();

    return EXCLUDED_JOB_DOMAINS.some(domain => {
        return lowerUrl.includes(domain);
    });
}

/**
 * Checks if a company name should be excluded from job search results
 * @param {string} companyName - The company name to check
 * @returns {boolean} - True if the company should be excluded
 */
function shouldExcludeCompany(companyName) {
    if (!companyName) return false;

    const lowerCompany = companyName.toLowerCase();

    return EXCLUDED_COMPANY_NAMES.some(excludedName => {
        return lowerCompany.includes(excludedName);
    });
}

/**
 * Checks if a job should be excluded because it's hourly/per hour work
 * @param {Object} result - The search result object with title and snippet
 * @returns {boolean} - True if the job should be excluded (is hourly)
 */
function shouldExcludeHourlyJob(result) {
    if (!result) return false;

    const textToCheck = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();

    // Patterns that indicate hourly work
    const hourlyPatterns = [
        'per hour',
        'hourly rate',
        'hourly wage',
        'hourly pay',
        '/hour',
        '/hr',
        'hour rate',
        'hour wage',
        'hour pay'
    ];

    return hourlyPatterns.some(pattern => textToCheck.includes(pattern));
}

/**
 * Extracts job title from search result title
 * @param {string} title - The search result title
 * @returns {string} - Extracted job title
 */
function extractJobTitle(title) {
    if (!title) return 'Unknown Position';
    
    // Common patterns to extract job titles
    const patterns = [
        /^([^|]+)\s*\|\s*/, // "Executive Chef | Company Name"
        /^([^-]+)\s*-\s*/, // "Executive Chef - Company Name"
        /^([^@]+)\s*@\s*/, // "Executive Chef @ Company Name"
        /^([^,]+),\s*/, // "Executive Chef, Company Name"
        /^(.+?)\s+(?:at|with|for)\s+/i, // "Executive Chef at Company Name"
    ];
    
    for (const pattern of patterns) {
        const match = title.match(pattern);
        if (match) {
            return match[1].trim();
        }
    }
    
    // If no pattern matches, clean up common suffixes
    let cleanTitle = title
        .replace(/\s*-\s*.*$/, '') // Remove everything after first dash
        .replace(/\s*\|\s*.*$/, '') // Remove everything after first pipe
        .replace(/\s*@\s*.*$/, '') // Remove everything after first @
        .replace(/\s*,\s*.*$/, '') // Remove everything after first comma
        .trim();
    
    return cleanTitle || 'Unknown Position';
}

/**
 * Checks if a company name is a salary-related word that should be excluded
 * @param {string} companyName - The company name to check
 * @returns {boolean} - True if the company name is a salary-related word
 */
function isSalaryCompanyName(companyName) {
    if (!companyName || typeof companyName !== 'string') return false;

    const lowerName = companyName.toLowerCase().trim();

    // Simple list of salary-related words that shouldn't be company names
    const salaryWords = [
        'salary',
        'pay',
        'wage',
        'wages',
        'compensation',
        'benefits',
        'hourly',
        'annual',
        'competitive'
    ];

    return salaryWords.includes(lowerName);
}

/**
 * Extracts company name from search result
 * @param {Object} result - The search result object
 * @returns {string} - Extracted company name
 */
function extractCompanyName(result) {
    if (!result) return 'Unknown Company';
    
    // Try to get company from source first
    if (result.source && result.source !== 'Bing') {
        let company = result.source
            .replace(/\.com$/, '')
            .replace(/\.org$/, '')
            .replace(/\.net$/, '')
            .replace(/^www\./, '')
            .trim();

        if (company && company.length > 2 && !isSalaryCompanyName(company)) {
            return company;
        }
    }

    // Try to extract from domain
    if (result.domain) {
        let company = result.domain
            .replace(/^www\./, '')
            .replace(/\.com$/, '')
            .replace(/\.org$/, '')
            .replace(/\.net$/, '')
            .trim();

        if (company && company.length > 2 && !isSalaryCompanyName(company)) {
            return company;
        }
    }

    // Try to extract from link
    if (result.link) {
        try {
            const url = new URL(result.link);
            let company = url.hostname
                .replace(/^www\./, '')
                .replace(/\.com$/, '')
                .replace(/\.org$/, '')
                .replace(/\.net$/, '')
                .trim();

            if (company && company.length > 2 && !isSalaryCompanyName(company)) {
                return company;
            }
        } catch (error) {
            // Ignore URL parsing errors
        }
    }
    
    return 'Unknown Company';
}

/**
 * Extracts location from search result snippet or title
 * @param {Object} result - The search result object
 * @param {string} searchLocation - The location used in the search query
 * @returns {string} - Extracted location
 */
function extractLocation(result, searchLocation) {
    if (!result) return searchLocation || 'Unknown Location';
    
    const text = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
    
    // Common location patterns
    const locationPatterns = [
        /(?:in|at|located in)\s+([^,\n.]+(?:,\s*[A-Z]{2})?)/i,
        /([A-Za-z\s]+,\s*[A-Z]{2})\s*(?:\d{5})?/,
        /(new york|los angeles|chicago|houston|phoenix|philadelphia|san antonio|san diego|dallas|san jose|austin|jacksonville|fort worth|columbus|charlotte|san francisco|indianapolis|seattle|denver|washington|boston|el paso|detroit|nashville|portland|memphis|oklahoma city|las vegas|louisville|baltimore|milwaukee|albuquerque|tucson|fresno|sacramento|mesa|kansas city|atlanta|long beach|colorado springs|raleigh|miami|virginia beach|omaha|oakland|minneapolis|tulsa|arlington|new orleans|wichita|cleveland|tampa|bakersfield|aurora|honolulu|anaheim|santa ana|corpus christi|riverside|lexington|stockton|toledo|st\. paul|newark|greensboro|plano|henderson|lincoln|buffalo|jersey city|chula vista|fort wayne|orlando|st\. petersburg|chandler|laredo|norfolk|durham|madison|lubbock|irvine|winston-salem|glendale|garland|hialeah|reno|chesapeake|gilbert|baton rouge|irving|scottsdale|north las vegas|fremont|boise|richmond|san bernardino|birmingham|spokane|rochester|des moines|modesto|fayetteville|tacoma|oxnard|fontana|columbus|montgomery|moreno valley|shreveport|aurora|yonkers|akron|huntington beach|little rock|augusta|amarillo|glendale|mobile|grand rapids|salt lake city|tallahassee|huntsville|grand prairie|knoxville|worcester|newport news|brownsville|overland park|santa clarita|providence|garden grove|chattanooga|oceanside|jackson|fort lauderdale|santa rosa|rancho cucamonga|port st\. lucie|tempe|ontario|vancouver|cape coral|sioux falls|springfield|peoria|pembroke pines|elk grove|salem|lancaster|corona|eugene|palmdale|salinas|springfield|pasadena|fort collins|hayward|pomona|cary|rockford|alexandria|escondido|mckinney|kansas city|joliet|sunnyvale|torrance|bridgeport|lakewood|hollywood|paterson|naperville|syracuse|mesquite|dayton|savannah|clarksville|orange|pasadena|fullerton|killeen|frisco|hampton|mcallen|warren|west valley city|columbia|sterling heights|new haven|miramar|waco|thousand oaks|cedar rapids|charleston|sioux city|round rock|fargo|carrollton|roseville|concord|thornton|visalia|gainesville|olathe|denton|high point|richardson|pueblo|murfreesboro|lewisville|rochester|elgin|broken arrow|miami gardens|pearland|hartford|surprise|west jordan|college station|independence|clearwater|midland|inglewood|carlsbad|el monte|abilene|north charleston|berkeley|evansville|ann arbor|columbia|fairfield|vallejo|lansing|renton)/i
    ];
    
    for (const pattern of locationPatterns) {
        const match = text.match(pattern);
        if (match) {
            return match[1] || match[0];
        }
    }
    
    // Return the search location as fallback
    return searchLocation || 'Unknown Location';
}

/**
 * Extracts salary information from search result snippet
 * @param {Object} result - The search result object
 * @returns {string|null} - Extracted salary or null if not found
 */
function extractSalary(result) {
    if (!result || !result.snippet) return null;
    
    const text = result.snippet.toLowerCase();
    
    // Salary patterns
    const salaryPatterns = [
        /\$[\d,]+\s*-\s*\$[\d,]+/g, // $50,000 - $70,000
        /\$[\d,]+\s*to\s*\$[\d,]+/g, // $50,000 to $70,000
        /\$[\d,]+\s*\/\s*(?:year|yr|hour|hr)/g, // $50,000/year or $25/hour
        /salary:\s*\$[\d,]+/gi, // Salary: $50,000
        /pay:\s*\$[\d,]+/gi, // Pay: $50,000
    ];
    
    for (const pattern of salaryPatterns) {
        const matches = text.match(pattern);
        if (matches && matches.length > 0) {
            return matches[0];
        }
    }
    
    return null;
}

/**
 * Searches for jobs using Bing Search API via SearchAPI.io
 * @param {string} query - The search query (e.g., "restaurant chef jobs")
 * @param {string} location - The location to search in (e.g., "New York NY")
 * @param {number} maxResults - Maximum number of results to return (default: 10)
 * @returns {Promise<Array>} - Array of job objects
 */
async function searchJobsWithBing(query, location = '', maxResults = 100) {
    const apiKey = process.env.SEARCH_API_KEY;

    if (!apiKey) {
        console.warn('SEARCH_API_KEY environment variable not found. Skipping Bing search.');
        return [];
    }

    try {
        // Build search query with job-specific terms and location
        let searchQuery = query;
        if (location) {
            searchQuery += ` ${location}`;
        }

        // Add terms to find job listings and exclude major job boards
        searchQuery += ' ("now hiring" OR "job opening" OR "career" OR "position" OR "employment")';

        // Exclude major job boards to get direct company results
        const excludeTerms = EXCLUDED_JOB_DOMAINS.slice(0, 10).map(domain => `-site:${domain}`).join(' ');
        searchQuery += ` ${excludeTerms}`;

        // Build the API URL
        const searchUrl = `https://www.searchapi.io/api/v1/search?engine=bing&q=${encodeURIComponent(searchQuery)}&api_key=${apiKey}&num=${maxResults}`;

        console.info(`BING SEARCH: Searching for "${searchQuery}"`);

        const response = await fetch(searchUrl);
        const data = await response.json();

        if (!response.ok) {
            console.error(`Bing Search API error: ${data.error || response.statusText}`);
            return [];
        }

        // Check if we have organic results
        if (!data.organic_results || data.organic_results.length === 0) {
            console.info(`No Bing search results found for "${query}" in "${location}"`);
            return [];
        }

        console.info(`Found ${data.organic_results.length} Bing search results for "${query}" in "${location}"`);

        // Process and filter results
        const jobs = [];

        for (let i = 0; i < data.organic_results.length; i++) {
            const result = data.organic_results[i];

            // Skip excluded domains
            if (shouldExcludeJobUrl(result.link)) {
                console.info(`Skipping excluded domain result #${i+1}: ${result.link}`);
                continue;
            }

            // Skip hourly jobs
            if (shouldExcludeHourlyJob(result)) {
                console.info(`Skipping hourly job result #${i+1}: "${result.title}" (contains hourly/per hour text)`);
                continue;
            }

            // Extract job information
            const jobTitle = extractJobTitle(result.title);
            const company = extractCompanyName(result);
            const jobLocation = extractLocation(result, location);
            const salary = extractSalary(result);

            // Skip if company is a job board or recruiting site
            if (shouldExcludeCompany(company)) {
                console.info(`Skipping excluded company result #${i+1}: "${company}" from ${result.link}`);
                continue;
            }

            // Skip if company name is a salary-related word
            if (isSalaryCompanyName(company)) {
                console.info(`Skipping result #${i+1}: Company name is a salary-related word: "${company}" from ${result.link}`);
                continue;
            }

            // Debug: Log company name for troubleshooting
            console.info(`Company extracted: "${company}" from ${result.link}`);

            // Skip if we can't extract basic job info
            if (jobTitle === 'Unknown Position' && company === 'Unknown Company') {
                console.info(`Skipping result #${i+1}: Unable to extract job info from "${result.title}"`);
                continue;
            }

            // Create job object matching your existing schema
            const job = {
                title: jobTitle,
                company: company,
                location: jobLocation,
                salary: salary,
                apply_link: result.link,
                description: result.snippet || '',
                company_domain: extractDomainFromUrl(result.link),
                source: 'Bing Search'
            };

            jobs.push(job);
            console.info(`Extracted job #${i+1}: "${job.title}" at "${job.company}" - ${job.apply_link}`);
        }

        console.info(`Successfully extracted ${jobs.length} jobs from Bing search results`);
        return jobs;

    } catch (error) {
        console.error(`Error during Bing Search API call for "${query}": ${error.message}`);
        return [];
    }
}

/**
 * Extracts the domain from a URL
 * @param {string} url - The URL to extract the domain from
 * @returns {string|null} - The domain or null if invalid
 */
function extractDomainFromUrl(url) {
    if (!url) return null;

    try {
        const parsedUrl = new URL(url.startsWith('http') ? url : `http://${url}`);
        let domain = parsedUrl.hostname;

        // Remove www. prefix if present
        if (domain.startsWith('www.')) {
            domain = domain.substring(4);
        }

        return domain;
    } catch (error) {
        console.error(`Error extracting domain from URL ${url}: ${error.message}`);
        return null;
    }
}

/**
 * Searches for all jobs using Bing across multiple queries and locations
 * @param {Array} queries - Array of search queries
 * @param {string} location - Location filter
 * @param {number} maxResults - Maximum results per query
 * @param {Map} existingJobs - Map of existing jobs to avoid duplicates
 * @returns {Promise<Array>} - Array of job objects
 */
async function searchAllJobsWithBing(queries, location = '', maxResults = 100, existingJobs = null) {
    let allJobs = [];
    let skippedExistingJobs = 0;

    console.info(`Starting Bing search for ${queries.length} queries...`);

    for (const query of queries) {
        try {
            console.info(`Bing search for query: "${query}"`);

            // Extract location from query if not provided separately
            let searchLocation = location;
            if (!searchLocation) {
                // Try to extract location from the end of the query
                const locationMatch = query.match(/\b([A-Za-z\s]+(?:,\s*[A-Z]{2})?)\s*$/);
                if (locationMatch) {
                    searchLocation = locationMatch[1].trim();
                }
            }

            const jobs = await searchJobsWithBing(query, searchLocation, maxResults);

            if (jobs.length === 0) {
                console.info(`No jobs found for Bing query: "${query}"`);
                continue;
            }

            // Filter out existing jobs if we have the map
            if (existingJobs && existingJobs.size > 0) {
                const newJobs = [];

                for (const job of jobs) {
                    // Create a key using title+company
                    const key = `${job.title.toLowerCase()}|${job.company.toLowerCase()}`;

                    if (existingJobs.has(key)) {
                        // Job already exists in database, skip it
                        console.info(`Skipping existing Bing job: "${job.title}" at "${job.company}" (already in database)`);
                        skippedExistingJobs++;

                        // Add a flag to indicate this job was skipped due to existing in DB
                        job._existsInDatabase = true;

                        // Still add to allJobs for tracking purposes
                        allJobs.push(job);
                    } else {
                        // Job doesn't exist, add it to the list of new jobs
                        newJobs.push(job);
                        allJobs.push(job);
                    }
                }

                console.info(`Bing query "${query}": Found ${jobs.length} jobs, ${jobs.length - newJobs.length} already exist in database`);
            } else {
                // No existing jobs map, add all jobs
                allJobs = [...allJobs, ...jobs];
                console.info(`Bing query "${query}": Found ${jobs.length} jobs`);
            }

            // Add delay between queries to avoid rate limiting
            if (queries.indexOf(query) < queries.length - 1) {
                console.info('Adding delay between Bing queries...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

        } catch (error) {
            console.error(`Error processing Bing query "${query}": ${error.message}`);
        }
    }

    console.info(`Bing search completed: ${allJobs.length} total jobs found (${skippedExistingJobs} already exist in database)`);
    return allJobs;
}

export {
    searchJobsWithBing,
    searchAllJobsWithBing,
    shouldExcludeJobUrl,
    shouldExcludeCompany,
    shouldExcludeHourlyJob,
    isSalaryCompanyName,
    extractJobTitle,
    extractCompanyName,
    extractLocation,
    extractSalary,
    extractDomainFromUrl,
    EXCLUDED_JOB_DOMAINS,
    EXCLUDED_COMPANY_NAMES
};

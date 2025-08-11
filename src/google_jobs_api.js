/**
 * Google Jobs API integration using SearchAPI.io
 * This module provides functions to search for job listings using the Google Jobs API via SearchAPI.io
 * and enrich the data with company website URLs (email enrichment is handled by the web viewer)
 */

import { getWebsiteUrlFromSearchAPI, getDomainFromUrl } from './search_api.js';
import { EXCLUDED_RESTAURANT_CHAINS } from './excluded_chains.js';
import { isSalaryCompanyName, shouldExcludeJobUrl, EXCLUDED_JOB_DOMAINS } from './bing_search_api.js';

// Exclude major job boards to prioritize direct employer postings
const EXCLUDED_JOB_SOURCES = new Set([
    'Indeed', 'Glassdoor', 'ZipRecruiter', 'Monster', 'CareerBuilder', 'SimplyHired', 'Snagajob', 'LinkedIn'
]);

function shouldExcludeHourlyGoogle(job) {
    const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();
    return /\b(per\s+hour|hourly|\$\s*\d+\s*\/\s*(hour|hr)|\/hr|\/hour)\b/i.test(text);
}

/**
 * Searches for job listings using the Google Jobs API
 * @param {string} query - The search query (e.g., "restaurant chef united states")
 * @param {string} location - Optional location filter (e.g., "New York")
 * @param {string} nextPageToken - Optional token for pagination
 * @returns {Promise<Object>} - Job listings and pagination info
 */
async function searchJobs(query, location = '', nextPageToken = null) {
    const apiKey = process.env.SEARCH_API_KEY;

    if (!apiKey) {
        console.warn('SEARCH_API_KEY environment variable not found. Skipping Google Jobs search.');
        return { jobs: [], hasMore: false };
    }

    try {
        // Build the API URL
        let searchUrl = `https://www.searchapi.io/api/v1/search?engine=google_jobs&q=${encodeURIComponent(query)}&api_key=${apiKey}`;

        // Add cache-busting parameter to ensure fresh results
        searchUrl += `&_cacheBust=${Date.now()}`;

        // Add location if provided — city should be central, so rely on location param not query text
        if (location) {
            searchUrl += `&location=${encodeURIComponent(location)}`;
        }

        // Add pagination token if provided
        if (nextPageToken) {
            searchUrl += `&next_page_token=${encodeURIComponent(nextPageToken)}`;
        }

        console.info(`GOOGLE JOBS API: Searching for jobs with query "${query}"${location ? ` in ${location}` : ''}`);
        console.info(`API URL: ${searchUrl.replace(apiKey, '***')}`); // Log URL without API key

        const response = await fetch(searchUrl);

        if (!response.ok) {
            console.error(`Google Jobs API HTTP error: ${response.status} ${response.statusText}`);
            const errorText = await response.text();
            console.error(`Error response body: ${errorText}`);
            return { jobs: [], hasMore: false };
        }

        const data = await response.json();

        // Check for API-level errors in the response
        if (data.error) {
            console.error(`Google Jobs API error: ${data.error}`);
            if (data.error_message) {
                console.error(`Error message: ${data.error_message}`);
            }
            return { jobs: [], hasMore: false };
        }

        // Check if we have job results
        if (!data.jobs || data.jobs.length === 0) {
            console.info(`No job results found for "${query}"`);
            console.info(`Response structure: ${JSON.stringify(Object.keys(data), null, 2)}`);
            return { jobs: [], hasMore: false };
        }

        // Early URL/source/company filtering to reduce runtime
        const brandKeywords = new Set([
            'indeed','glassdoor','ziprecruiter','monster','careerbuilder','simplyhired','snagajob','linkedin'
        ]);
        EXCLUDED_JOB_DOMAINS.forEach(d => {
            const base = d.replace(/^www\./, '').split('.')[0];
            if (base) brandKeywords.add(base.toLowerCase());
        });

        const filteredRawJobs = data.jobs.filter(raw => {
            try {
                // Exclude hourly roles quickly
                if (shouldExcludeHourlyGoogle(raw)) return false;

                // Exclude by main apply link domain
                if (raw.apply_link && shouldExcludeJobUrl(raw.apply_link)) return false;

                // Exclude if all alternate apply links are excluded
                if (Array.isArray(raw.apply_links) && raw.apply_links.length > 0) {
                    const allExcluded = raw.apply_links.every(l => shouldExcludeJobUrl(l.link));
                    if (allExcluded) return false;
                }

                // Exclude by VIA/Source brand text
                if (raw.via) {
                    const viaLower = String(raw.via).toLowerCase();
                    for (const kw of brandKeywords) {
                        if (viaLower.includes(kw)) return false;
                    }
                }

                // Exclude by explicit company name when present
                if (raw.company_name) {
                    const companyCheck = shouldExcludeCompany(raw.company_name);
                    if (companyCheck.isExcluded) return false;
                    if (isSalaryCompanyName(raw.company_name)) return false;
                }

                return true;
            } catch (e) {
                return true;
            }
        });

        // Log the number of jobs found
        console.info(`Found ${data.jobs.length} job listings for "${query}" (${filteredRawJobs.length} after early filtering)`);

        // Log pagination info for debugging
        if (data.pagination) {
            console.info(`Pagination info: current page token: ${data.pagination.current_page_token || 'none'}, next page token: ${data.pagination.next_page_token || 'none'}`);
        }

        // Process the jobs to extract relevant information
        let processedJobs = filteredRawJobs.map(job => {
            // Extract company name from various sources
            let companyName = job.company_name;

            // If company_name is not available, try to extract from title or description
            if (!companyName) {
                // Try to extract from title (e.g., "McDonald's - Cook")
                const titleMatch = job.title ? job.title.match(/^(.*?)\s+-\s+/) : null;
                if (titleMatch && titleMatch[1] && !isSalaryCompanyName(titleMatch[1])) {
                    companyName = titleMatch[1];
                }

                // If still not found, try to extract from description
                if (!companyName && job.description) {
                    // Look for common patterns like "Join our team at [Company]"
                    const descMatch = job.description.match(/(?:at|with|for|join)\s+([\w\s&']+?)(?:\sin|\.|\!|\,)/i);
                    if (descMatch && descMatch[1] && !isSalaryCompanyName(descMatch[1].trim())) {
                        companyName = descMatch[1].trim();
                    }
                }
            }

            // Final check: if the extracted company name is a salary-related word, reset to Unknown
            if (companyName && isSalaryCompanyName(companyName)) {
                console.info(`Company name is a salary-related word, resetting: "${companyName}"`);
                companyName = 'Unknown Company';
            }

            return {
                title: job.title || 'Unknown Title',
                company: companyName || 'Unknown Company',
                location: job.location || 'Unknown Location',
                posted_at: job.detected_extensions?.posted_at || 'Unknown',
                schedule: job.detected_extensions?.schedule || 'Unknown',
                description: job.description || 'No description available',
                highlights: job.job_highlights || [],
                extensions: job.extensions || [],
                apply_link: job.apply_link || null,
                apply_links: job.apply_links || [],
                source: job.via ? job.via.replace('via ', '') : 'Unknown Source'
            };
        });

        // Filter out hourly jobs and major job boards to reduce noise and runtime
        processedJobs = processedJobs.filter(j => !shouldExcludeHourlyGoogle(j));
        processedJobs = processedJobs.filter(j => !EXCLUDED_JOB_SOURCES.has((j.source || '').trim()))

        return {
            jobs: processedJobs,
            hasMore: !!data.pagination?.next_page_token,
            nextPageToken: data.pagination?.next_page_token || null
        };

    } catch (error) {
        console.error(`Error during Google Jobs API call for "${query}": ${error.message}`);
        return { jobs: [], hasMore: false };
    }
}

/**
 * Searches for all job listings across multiple pages
 * @param {string} query - The search query
 * @param {string} location - Optional location filter
 * @param {number} maxPages - Maximum number of pages to fetch (default: 5)
 * @param {Map} existingJobs - Optional map of existing job title+company combinations
 * @returns {Promise<Array>} - All job listings
 */
async function searchAllJobs(query, location = '', maxPages = 20, existingJobs = null) {
    let allJobs = [];
    let nextPageToken = null;
    let currentPage = 0;
    let skippedExistingJobs = 0;

    do {
        currentPage++;
        console.info(`Fetching page ${currentPage} of job results...`);

        const result = await searchJobs(query, location, nextPageToken);

        if (result.jobs.length === 0) {
            break;
        }

        // If we have a map of existing jobs, filter out jobs that already exist
        if (existingJobs && existingJobs.size > 0) {
            const newJobs = [];

            for (const job of result.jobs) {
                // Create a key using title+company
                const key = `${job.title.toLowerCase()}|${job.company.toLowerCase()}`;

                if (existingJobs.has(key)) {
                    // Job already exists in database, skip it
                    console.info(`Skipping existing job: "${job.title}" at "${job.company}" (already in database)`);
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

            console.info(`Page ${currentPage}: Found ${result.jobs.length} jobs, ${result.jobs.length - newJobs.length} already exist in database`);
        } else {
            // No existing jobs map, add all jobs
            allJobs = [...allJobs, ...result.jobs];
        }

        nextPageToken = result.nextPageToken;

        // Add a small delay between requests to avoid rate limiting
        if (result.hasMore && currentPage < maxPages) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

    } while (nextPageToken && currentPage < maxPages);

    console.info(`Fetched a total of ${allJobs.length} jobs across ${currentPage} pages (${skippedExistingJobs} already exist in database)`);
    return allJobs;
}

/**
 * List of excluded companies
 */
const EXCLUDED_COMPANIES = new Set([
    "Alliance Personnel", "Aramark", "August Point Advisors", "Bon Appetit", "Capital Restaurant Associates",
    "Chartwells", "Compass", "CORE Recruitment", "EHS Recruiting", "Empowered Hospitality",
    "Eurest", "Gecko Hospitality", "Goodwin Recruiting", "HMG Plus - New York", "Hospitality Confidential", "LSG Sky Chefs", "Major Food Group",
    "Measured HR", "One Haus", "Patrice & Associates", "Persone NYC", "Playbook Advisors",
    "Restaurant Associates", "Source One Hospitality", "Ten Five Hospitality",
    "The Goodkind Group", "Tuttle Hospitality", "Willow Tree Recruiting",
    // Adding Washington variants
    "washington", "washington dc", "washington d.c.", "washington d c",
    // Convenience stores and gas station chains to exclude
    "7-Eleven", "Couche-Tard", "Circle K", "Speedway", "Casey's General Stores", "CST Brands", "Corner Store",
    "Aplus", "MACS", "Tigermarket", "Stripes", "Aloha", "Murphy USA", "Murphy Express", "ampm",
    "Kroger", "Turkey Hill", "Kwik Shop", "Quik Stop", "Suncor Energy", "Petro-Canada", "Neighbours", "SuperStop",
    "GPM Investments", "Fas Mart", "Shore Stop", "Scotchman", "QuikTrip", "Chevron Corp.", "ExtraMile", "Caltex",
    "Wawa", "Pilot Travel Centers", "Flying J", "Cumberland Farms", "Kum & Go", "Kwik Trip", "Kwik Star", "Sheetz",
    "Holiday Stationstores", "Shell Canada Select", "Husky", "Mohawk", "TravelCenters of America", "Petro Stopping Centers",
    "Minit Mart", "RaceTrac", "RaceWay", "Delek U.S.", "Mapco", "Love's Travel Stops & Country Stores",
    "Stewart's Shops", "United Pacific", "We Got It!", "United Mart", "My Goods", "Allsup's Convenience Stores",
    "Alon Brands", "Sunshine Gasoline Distributors", "Kwik Fill", "Red Apple", "E-Z Mart Stores", "Xtra Mart", "Alltown",
    "Maverik", "SuperAmerica", "Western Refining", "Giant", "Mustang", "Sundial", "Howdy's", "Shop24",
    "Convenient Food Mart", "CEFCO Convenience Stores", "Meijer Gas Stations", "Jacksons Food Stores",
    "Timewise Food Stores", "Anabi Oil", "Shell", "GetGo", "United Dairy Farmers", "Thorntons", "Snack Express",
    "Verve", "Esso", "Pioneer", "Admiral", "Royal Farms", "Terrible Herbst", "Flash Foods", "G&M Food Mart",
    "QuickChek", "American Retail Services", "Hy-Vee Gas", "Loop Neighborhood", "GoMart Food Stores",
    "Duchess Shoppes", "Blarney Castle", "EZ Mart", "Quality Mart", "Quality Plus", "GOGAS", "Huck's",
    "Petroleum Mktg. Group", "E&C Enterprises Inc.", "7-Eleven Stores of Oklahoma", "Plaid Pantry", "truenorth",
    "Little General Stores", "Town Pump Food Stores", "Star Stop", "Roadrunner Markets", "Gasamat", "Smoker Friendly",
    "Family Fare", "Tri Star Energy", "Twice Daily", "Daily's", "Lil' Mart", "Sprint Mart", "Certified",
    "Flash Market", "Spinx", "Bucky's Convenience Stores", "MotoMart", "Shell Express Lane", "C.N. Brown",
    "Big Apple Food Stores", "FiveStar Food Marts", "Toot'n Totum Food Stores", "Sampson-Bladen Oil", "Han-Dee Hugo's",
    "MFA Oil", "Break Time", "Express Mart", "Mirabito", "Quickway Food Stores", "Convenience Express",
    "Manley's Mighty-Mart", "ABC Stores", "GATE Stores", "Krist Food Marts", "Country Fair", "Cenex Zip Trip",
    "Southwest Georgia Oil", "Dandy Mini Marts", "Stinker Stores", "Dash In", "Weigel's Farm Stores",
    "Family Express", "Shop Rite Inc.", "Tobacco Plus", "Enmark Station", "Enmarket"
].map(name => name.toLowerCase()));

/**
 * List of fast food restaurants to exclude
 * Source: https://github.com/ajaykumar1196/American-Fast-Food-Restaurants
 */
const FAST_FOOD_RESTAURANTS = new Set([
    "McDonald's", "Burger King", "Wendy's", "Subway", "Taco Bell", "Pizza Hut",
    "KFC", "Chick-fil-A", "Sonic Drive-In", "Domino's Pizza", "Dairy Queen",
    "Papa John's", "Arby's", "Little Caesars", "Popeyes", "Chipotle", "Hardee's",
    "Jimmy John's", "Zaxby's", "Five Guys", "Whataburger", "Culver's", "Steak 'n Shake",
    "Church's Chicken", "Raising Cane's", "Wingstop", "Qdoba", "Jersey Mike's Subs",
    "Firehouse Subs", "Moe's Southwest Grill", "McAlister's Deli", "Panda Express",
    "Panera Bread", "Bojangles'", "El Pollo Loco", "Del Taco", "In-N-Out Burger",
    "White Castle", "Checkers", "Rally's", "Shake Shack", "Smashburger", "Auntie Anne's",
    "Baskin-Robbins", "Boston Market", "Captain D's", "Carl's Jr.", "Charleys Philly Steaks",
    "Chuck E. Cheese's", "Cinnabon", "Cold Stone Creamery", "Cousins Subs", "Dunkin'",
    "Einstein Bros. Bagels", "Fazoli's", "Godfather's Pizza", "Golden Corral", "Hungry Howie's",
    "Jamba Juice", "Jason's Deli", "Jollibee", "Krispy Kreme", "Krystal", "Long John Silver's",
    "Marco's Pizza", "Nathan's Famous", "Noodles & Company", "Penn Station", "Port of Subs",
    "Potbelly Sandwich Shop", "Quiznos", "Round Table Pizza", "Roy Rogers", "Rubio's",
    "Schlotzsky's", "Smoothie King", "Starbucks", "Taco John's", "Tim Hortons", "Tropical Smoothie Cafe",
    "Wienerschnitzel", "Wing Street", "Zoup!"
].map(name => name.toLowerCase()));

/**
 * Normalizes company name for better matching by removing apostrophes and extra spaces
 * @param {string} name - Company name to normalize
 * @returns {string} - Normalized company name
 */
function normalizeCompanyName(name) {
    if (!name) return '';
    return name.toLowerCase()
        .replace(/'/g, '')  // Remove apostrophes
        .replace(/'/g, '')  // Remove smart apostrophes
        .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
        .trim();
}

/**
 * Checks if a company should be excluded based on exclusion lists
 * @param {string} company - Company name to check
 * @returns {Object} - Object with isExcluded flag and reason
 */
function shouldExcludeCompany(company) {
    if (!company || company === 'Unknown Company') return { isExcluded: false, reason: null };

    const lowerCompany = company.toLowerCase();
    const normalizedCompany = normalizeCompanyName(company);

    // Check excluded companies list (recruiters, etc.)
    for (const excluded of EXCLUDED_COMPANIES) {
        const normalizedExcluded = normalizeCompanyName(excluded);
        if (lowerCompany.includes(excluded) || normalizedCompany.includes(normalizedExcluded)) {
            return { isExcluded: true, reason: 'excluded_company', match: excluded };
        }
    }

    // Check fast food restaurants list (original list)
    for (const fastFood of FAST_FOOD_RESTAURANTS) {
        const normalizedFastFood = normalizeCompanyName(fastFood);
        // Use more precise matching for fast food with normalized names
        if (lowerCompany === fastFood ||
            normalizedCompany === normalizedFastFood ||
            lowerCompany.includes(` ${fastFood} `) ||
            lowerCompany.startsWith(`${fastFood} `) ||
            lowerCompany.endsWith(` ${fastFood}`) ||
            normalizedCompany.includes(` ${normalizedFastFood} `) ||
            normalizedCompany.startsWith(`${normalizedFastFood} `) ||
            normalizedCompany.endsWith(` ${normalizedFastFood}`)) {
            return { isExcluded: true, reason: 'fast_food', match: fastFood };
        }
    }

    // Check comprehensive restaurant chains list
    for (const chain of EXCLUDED_RESTAURANT_CHAINS) {
        const lowerChain = chain.toLowerCase();
        const normalizedChain = normalizeCompanyName(chain);
        // Use more precise matching for restaurant chains with normalized names
        if (lowerCompany === lowerChain ||
            normalizedCompany === normalizedChain ||
            lowerCompany.includes(` ${lowerChain} `) ||
            lowerCompany.startsWith(`${lowerChain} `) ||
            lowerCompany.endsWith(` ${lowerChain}`) ||
            lowerCompany.includes(lowerChain) ||
            normalizedCompany.includes(` ${normalizedChain} `) ||
            normalizedCompany.startsWith(`${normalizedChain} `) ||
            normalizedCompany.endsWith(` ${normalizedChain}`) ||
            normalizedCompany.includes(normalizedChain)) {
            return { isExcluded: true, reason: 'restaurant_chain', match: chain };
        }
    }

    return { isExcluded: false, reason: null };
}

/**
 * Extracts structured data from job listings
 * @param {Array} jobs - Array of job objects from searchJobs or searchAllJobs
 * @param {boolean} includeWebsiteData - Whether to include company website data (email enrichment handled by web viewer)
 * @returns {Promise<Array>} - Array of structured job data ready for database insertion
 */
async function processJobsForDatabase(jobs, includeWebsiteData = false) {
    console.info(`Processing ${jobs.length} jobs for database insertion...`);

    let excludedCount = 0;
    let excludedByCompany = 0;
    let excludedByFastFood = 0;
    let excludedByRestaurantChain = 0;
    let skippedExistingCount = 0;

    // Process each job sequentially to avoid rate limiting
    const processedJobs = [];

    for (const job of jobs) {
        // Skip jobs that already exist in the database (marked by searchAllJobs)
        if (job._existsInDatabase) {
            console.info(`Skipping API calls for existing job: "${job.title}" at "${job.company}" (already in database)`);
            skippedExistingCount++;

            // Add a basic processed job for tracking purposes
            const basicProcessedJob = {
                title: job.title,
                company: job.company,
                location: job.location,
                posted_at: job.posted_at,
                schedule: job.schedule,
                description: job.description,
                apply_link: job.apply_link,
                source: job.source,
                scraped_at: new Date().toISOString(),
                _existsInDatabase: true
            };

            processedJobs.push(basicProcessedJob);
            continue;
        }

        // Check if company name is a salary-related word
        if (isSalaryCompanyName(job.company)) {
            console.info(`Excluding job with salary-related company name: "${job.title}" at "${job.company}"`);
            excludedCount++;
            excludedByCompany++; // Count as excluded company for stats

            // Add excluded job to the return value for tracking
            job._exclusionReason = 'salary_company_name';
            job._exclusionMatch = job.company;

            continue;
        }

        // Check if company should be excluded
        const exclusionCheck = shouldExcludeCompany(job.company);
        if (exclusionCheck.isExcluded) {
            if (exclusionCheck.reason === 'excluded_company') {
                console.info(`Excluding job at excluded company: "${job.title}" at "${job.company}" (matched: ${exclusionCheck.match})`);
                excludedByCompany++;
            } else if (exclusionCheck.reason === 'fast_food') {
                console.info(`Excluding job at fast food restaurant: "${job.title}" at "${job.company}" (matched: ${exclusionCheck.match})`);
                excludedByFastFood++;
            } else if (exclusionCheck.reason === 'restaurant_chain') {
                console.info(`Excluding job at restaurant chain: "${job.title}" at "${job.company}" (matched: ${exclusionCheck.match})`);
                excludedByRestaurantChain++;
            }
            excludedCount++;

            // Add excluded job to the return value for tracking
            job._exclusionReason = exclusionCheck.reason;
            job._exclusionMatch = exclusionCheck.match;

            continue;
        }

        // Log jobs that are being kept
        console.info(`Processing job: "${job.title}" at "${job.company}"`);

        // Extract salary information from description or highlights
        const salaryInfo = extractSalaryInfo(job);

        // Extract skills from description or highlights
        const skills = extractSkills(job);

        // Calculate experience level based on title and description
        const experienceLevel = calculateExperienceLevel(job);

        // Initialize the processed job object
        const processedJob = {
            title: job.title,
            company: job.company,
            location: job.location,
            posted_at: job.posted_at,
            schedule: job.schedule,
            description: job.description,
            salary_min: salaryInfo.min,
            salary_max: salaryInfo.max,
            salary_currency: salaryInfo.currency,
            salary_period: salaryInfo.period,
            skills: skills,
            experience_level: experienceLevel,
            apply_link: job.apply_link,
            source: job.source,
            scraped_at: new Date().toISOString(),
            company_website: null,
            company_domain: null,
            emails: [] // Email enrichment handled by web viewer
        };

        // If website data collection is enabled, get company website URL
        if (includeWebsiteData) {
            try {
                console.info(`Collecting website data for ${job.company}...`);

                // Get company website URL
                const companyUrl = await getWebsiteUrlFromSearchAPI(job.company);
                if (companyUrl) {
                    processedJob.company_website = companyUrl;
                    console.info(`Found website URL for ${job.company}: ${companyUrl}`);

                    // Extract domain from URL
                    const domain = getDomainFromUrl(companyUrl);
                    if (domain) {
                        processedJob.company_domain = domain;
                        console.info(`Extracted domain for ${job.company}: ${domain}`);
                    } else {
                        console.info(`Could not extract domain from URL: ${companyUrl}`);
                    }
                } else {
                    console.info(`No website URL found for ${job.company}`);
                }

                // Add a small delay between API calls to avoid rate limiting
                console.info(`Adding delay before processing next job...`);
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                console.error(`Error collecting website data for ${job.company}: ${error.message}`);
                if (error.stack) {
                    console.error(`Stack trace: ${error.stack}`);
                }
            }
        }

        processedJobs.push(processedJob);
    }

    console.info(`Filtering results: ${excludedCount} jobs excluded (${excludedByCompany} by recruiter list, ${excludedByFastFood} by fast food list, ${excludedByRestaurantChain} by restaurant chain list)`);
    console.info(`Skipped API calls for ${skippedExistingCount} jobs that already exist in the database`);
    console.info(`Returning ${processedJobs.length} jobs after filtering`);

    return processedJobs;
}

/**
 * Extracts salary information from job description and highlights
 * @param {Object} job - Job object
 * @returns {Object} - Structured salary information
 */
function extractSalaryInfo(job) {
    const salaryInfo = {
        min: null,
        max: null,
        currency: 'USD',
        period: 'yearly'
    };

    // Check job highlights first
    if (job.highlights && job.highlights.length > 0) {
        for (const highlight of job.highlights) {
            if (highlight.title === 'Compensation' && highlight.items && highlight.items.length > 0) {
                for (const item of highlight.items) {
                    const salaryMatch = item.match(/\$([0-9,.]+)(?:\s*-\s*\$([0-9,.]+))?(?:\s*(per|a|\/)\s*(hour|year|month|week|day))?/i);
                    if (salaryMatch) {
                        salaryInfo.min = parseFloat(salaryMatch[1].replace(/,/g, ''));
                        salaryInfo.max = salaryMatch[2] ? parseFloat(salaryMatch[2].replace(/,/g, '')) : salaryInfo.min;

                        if (salaryMatch[4]) {
                            const period = salaryMatch[4].toLowerCase();
                            if (period === 'hour') salaryInfo.period = 'hourly';
                            else if (period === 'year') salaryInfo.period = 'yearly';
                            else if (period === 'month') salaryInfo.period = 'monthly';
                            else if (period === 'week') salaryInfo.period = 'weekly';
                            else if (period === 'day') salaryInfo.period = 'daily';
                        }

                        break;
                    }
                }
            }
        }
    }

    // If no salary found in highlights, check description
    if (!salaryInfo.min && job.description) {
        const salaryMatch = job.description.match(/\$([0-9,.]+)(?:\s*-\s*\$([0-9,.]+))?(?:\s*(per|a|\/)\s*(hour|year|month|week|day))?/i);
        if (salaryMatch) {
            salaryInfo.min = parseFloat(salaryMatch[1].replace(/,/g, ''));
            salaryInfo.max = salaryMatch[2] ? parseFloat(salaryMatch[2].replace(/,/g, '')) : salaryInfo.min;

            if (salaryMatch[4]) {
                const period = salaryMatch[4].toLowerCase();
                if (period === 'hour') salaryInfo.period = 'hourly';
                else if (period === 'year') salaryInfo.period = 'yearly';
                else if (period === 'month') salaryInfo.period = 'monthly';
                else if (period === 'week') salaryInfo.period = 'weekly';
                else if (period === 'day') salaryInfo.period = 'daily';
            }
        }
    }

    return salaryInfo;
}

/**
 * Extracts skills from job description and highlights
 * @param {Object} job - Job object
 * @returns {Array} - Array of skills
 */
function extractSkills(job) {
    const commonCulinarySkills = [
        'cooking', 'baking', 'grilling', 'sautéing', 'knife skills',
        'food preparation', 'menu planning', 'recipe development',
        'food safety', 'sanitation', 'inventory management', 'kitchen management',
        'plating', 'garnishing', 'culinary arts', 'pastry', 'butchery',
        'sous vide', 'food presentation', 'catering', 'banquet'
    ];

    const skills = [];

    // Check if any common culinary skills are mentioned in the description
    if (job.description) {
        for (const skill of commonCulinarySkills) {
            if (job.description.toLowerCase().includes(skill.toLowerCase())) {
                skills.push(skill);
            }
        }
    }

    // Check job highlights for skills
    if (job.highlights && job.highlights.length > 0) {
        for (const highlight of job.highlights) {
            if (highlight.title === 'Qualifications' && highlight.items && highlight.items.length > 0) {
                for (const item of highlight.items) {
                    for (const skill of commonCulinarySkills) {
                        if (item.toLowerCase().includes(skill.toLowerCase()) && !skills.includes(skill)) {
                            skills.push(skill);
                        }
                    }
                }
            }
        }
    }

    return skills;
}

/**
 * Calculates experience level based on job title and description
 * @param {Object} job - Job object
 * @returns {string} - Experience level (entry, mid, senior, executive)
 */
function calculateExperienceLevel(job) {
    const title = job.title.toLowerCase();
    const description = job.description.toLowerCase();

    // Check for executive level positions
    if (title.includes('executive chef') ||
        title.includes('head chef') ||
        title.includes('chef de cuisine') ||
        title.includes('culinary director')) {
        return 'executive';
    }

    // Check for senior level positions
    if (title.includes('senior') ||
        title.includes('sr.') ||
        title.includes('lead') ||
        title.includes('sous chef')) {
        return 'senior';
    }

    // Check for entry level positions
    if (title.includes('junior') ||
        title.includes('jr.') ||
        title.includes('entry') ||
        title.includes('trainee') ||
        title.includes('apprentice') ||
        title.includes('commis')) {
        return 'entry';
    }

    // Default to mid-level
    return 'mid';
}

export {
    searchJobs,
    searchAllJobs,
    processJobsForDatabase
};

/**
 * Google Jobs API integration using SearchAPI.io
 * This module provides functions to search for job listings using the Google Jobs API via SearchAPI.io
 * and enrich the data with company website URLs and email addresses from Hunter.io
 */

import { getWebsiteUrlFromSearchAPI, getDomainFromUrl } from './search_api.js';
import { findEmailsWithHunter, findEmailsByCompanyName } from './hunter_api.js';

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

        // Add location if provided
        if (location) {
            searchUrl += `&location=${encodeURIComponent(location)}`;
        }

        // Add pagination token if provided
        if (nextPageToken) {
            searchUrl += `&next_page_token=${encodeURIComponent(nextPageToken)}`;
        }

        console.info(`GOOGLE JOBS API: Searching for jobs with query "${query}"${location ? ` in ${location}` : ''}`);

        const response = await fetch(searchUrl);
        const data = await response.json();

        if (!response.ok) {
            console.error(`Google Jobs API error: ${data.error || response.statusText}`);
            return { jobs: [], hasMore: false };
        }

        // Check if we have job results
        if (!data.jobs || data.jobs.length === 0) {
            console.info(`No job results found for "${query}"`);
            return { jobs: [], hasMore: false };
        }

        // Log the number of jobs found
        console.info(`Found ${data.jobs.length} job listings for "${query}"`);

        // Process the jobs to extract relevant information
        const processedJobs = data.jobs.map(job => {
            // Extract company name from various sources
            let companyName = job.company_name;

            // If company_name is not available, try to extract from title or description
            if (!companyName) {
                // Try to extract from title (e.g., "McDonald's - Cook")
                const titleMatch = job.title ? job.title.match(/^(.*?)\s+-\s+/) : null;
                if (titleMatch && titleMatch[1]) {
                    companyName = titleMatch[1];
                }

                // If still not found, try to extract from description
                if (!companyName && job.description) {
                    // Look for common patterns like "Join our team at [Company]"
                    const descMatch = job.description.match(/(?:at|with|for|join)\s+([\w\s&']+?)(?:\sin|\.|\!|\,)/i);
                    if (descMatch && descMatch[1]) {
                        companyName = descMatch[1].trim();
                    }
                }
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
 * @returns {Promise<Array>} - All job listings
 */
async function searchAllJobs(query, location = '', maxPages = 5) {
    let allJobs = [];
    let nextPageToken = null;
    let currentPage = 0;

    do {
        currentPage++;
        console.info(`Fetching page ${currentPage} of job results...`);

        const result = await searchJobs(query, location, nextPageToken);

        if (result.jobs.length === 0) {
            break;
        }

        allJobs = [...allJobs, ...result.jobs];
        nextPageToken = result.nextPageToken;

        // Add a small delay between requests to avoid rate limiting
        if (result.hasMore && currentPage < maxPages) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

    } while (nextPageToken && currentPage < maxPages);

    console.info(`Fetched a total of ${allJobs.length} jobs across ${currentPage} pages`);
    return allJobs;
}

/**
 * List of excluded companies
 */
const EXCLUDED_COMPANIES = new Set([
    "Alliance Personnel", "August Point Advisors", "Bon Appetit", "Capital Restaurant Associates",
    "Chartwells", "Compass", "CORE Recruitment", "EHS Recruiting", "Empowered Hospitality",
    "Eurest", "Goodwin Recruiting", "HMG Plus - New York", "LSG Sky Chefs", "Major Food Group",
    "Measured HR", "One Haus", "Patrice & Associates", "Persone NYC", "Playbook Advisors",
    "Restaurant Associates", "Source One Hospitality", "Ten Five Hospitality",
    "The Goodkind Group", "Tuttle Hospitality", "Willow Tree Recruiting",
    // Adding Washington variants
    "washington", "washington dc", "washington d.c.", "washington d c"
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
 * Checks if a company should be excluded based on exclusion lists
 * @param {string} company - Company name to check
 * @returns {Object} - Object with isExcluded flag and reason
 */
function shouldExcludeCompany(company) {
    if (!company || company === 'Unknown Company') return { isExcluded: false, reason: null };

    const lowerCompany = company.toLowerCase();

    // Check excluded companies list
    for (const excluded of EXCLUDED_COMPANIES) {
        if (lowerCompany.includes(excluded)) {
            return { isExcluded: true, reason: 'excluded_company', match: excluded };
        }
    }

    // Check fast food restaurants list
    for (const fastFood of FAST_FOOD_RESTAURANTS) {
        // Use more precise matching for fast food
        // Either exact match, or surrounded by word boundaries
        if (lowerCompany === fastFood ||
            lowerCompany.includes(` ${fastFood} `) ||
            lowerCompany.startsWith(`${fastFood} `) ||
            lowerCompany.endsWith(` ${fastFood}`)) {
            return { isExcluded: true, reason: 'fast_food', match: fastFood };
        }
    }

    return { isExcluded: false, reason: null };
}

/**
 * Extracts structured data from job listings
 * @param {Array} jobs - Array of job objects from searchJobs or searchAllJobs
 * @param {boolean} includeHunterData - Whether to include Hunter.io email data
 * @returns {Promise<Array>} - Array of structured job data ready for database insertion
 */
async function processJobsForDatabase(jobs, includeHunterData = false) {
    console.info(`Processing ${jobs.length} jobs for database insertion...`);

    let excludedCount = 0;
    let excludedByCompany = 0;
    let excludedByFastFood = 0;

    // Process each job sequentially to avoid rate limiting
    const processedJobs = [];

    for (const job of jobs) {
        // Check if company should be excluded
        const exclusionCheck = shouldExcludeCompany(job.company);
        if (exclusionCheck.isExcluded) {
            if (exclusionCheck.reason === 'excluded_company') {
                console.info(`Excluding job at excluded company: "${job.title}" at "${job.company}" (matched: ${exclusionCheck.match})`);
                excludedByCompany++;
            } else if (exclusionCheck.reason === 'fast_food') {
                console.info(`Excluding job at fast food restaurant: "${job.title}" at "${job.company}" (matched: ${exclusionCheck.match})`);
                excludedByFastFood++;
            }
            excludedCount++;
            continue;
        }

        // Log jobs that are being kept
        console.info(`Keeping job: "${job.title}" at "${job.company}"`);

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
            emails: []
        };

        // If Hunter.io integration is enabled, get company website and emails
        if (includeHunterData) {
            try {
                console.info(`Starting Hunter.io integration for ${job.company}...`);

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

                        // Find emails using Hunter.io
                        console.info(`Searching for emails using domain: ${domain}`);
                        const emails = await findEmailsWithHunter(domain, job.company);
                        if (emails && emails.length > 0) {
                            processedJob.emails = emails;
                            console.info(`Found ${emails.length} email addresses for ${job.company} using domain search`);

                            // Log the first few emails for debugging
                            emails.slice(0, 3).forEach((email, idx) => {
                                console.info(`  Email #${idx+1}: ${email.email} (${email.firstName || ''} ${email.lastName || ''})${email.position ? ` - ${email.position}` : ''}`);
                            });
                        } else {
                            console.info(`No email addresses found for ${job.company} using domain search`);

                            // Try direct company name search as fallback
                            console.info(`Trying direct company name search for ${job.company}`);
                            const companyEmails = await findEmailsByCompanyName(job.company);
                            if (companyEmails && companyEmails.length > 0) {
                                processedJob.emails = companyEmails;
                                console.info(`Found ${companyEmails.length} email addresses for ${job.company} using company name search`);

                                // Log the emails for debugging
                                companyEmails.forEach((email, idx) => {
                                    console.info(`  Email #${idx+1}: ${email.email} (${email.firstName || ''} ${email.lastName || ''})${email.position ? ` - ${email.position}` : ''}`);
                                });
                            } else {
                                console.info(`No email addresses found for ${job.company} using any method`);
                            }
                        }
                    } else {
                        console.info(`Could not extract domain from URL: ${companyUrl}`);

                        // Try direct company name search as fallback
                        console.info(`Trying direct company name search for ${job.company}`);
                        const companyEmails = await findEmailsByCompanyName(job.company);
                        if (companyEmails && companyEmails.length > 0) {
                            processedJob.emails = companyEmails;
                            console.info(`Found ${companyEmails.length} email addresses for ${job.company} using company name search`);
                        }
                    }
                } else {
                    console.info(`No website URL found for ${job.company}`);

                    // Try direct company name search as fallback
                    console.info(`Trying direct company name search for ${job.company}`);
                    const companyEmails = await findEmailsByCompanyName(job.company);
                    if (companyEmails && companyEmails.length > 0) {
                        processedJob.emails = companyEmails;
                        console.info(`Found ${companyEmails.length} email addresses for ${job.company} using company name search`);
                    } else {
                        console.info(`No email addresses found for ${job.company} using any method`);
                    }
                }

                // Add a small delay between API calls to avoid rate limiting
                console.info(`Adding delay before processing next job...`);
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.error(`Error enriching job data for ${job.company}: ${error.message}`);
                if (error.stack) {
                    console.error(`Stack trace: ${error.stack}`);
                }
            }
        }

        processedJobs.push(processedJob);
    }

    console.info(`Filtering results: ${excludedCount} jobs excluded (${excludedByCompany} by company list, ${excludedByFastFood} by fast food list)`);
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

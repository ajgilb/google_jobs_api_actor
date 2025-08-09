/**
 * Google Jobs API Actor
 *
 * This actor uses the SearchAPI.io Google Jobs API to search for job listings
 * and save them to a dataset or push them to a database.
 */
import { Actor } from 'apify';
import { searchAllJobs, processJobsForDatabase } from './google_jobs_api.js';
import { searchAllJobsWithBing } from './bing_search_api.js';
import { testFunction } from './test.js';
import { sendCompletionEmail } from './email.js';
import {
    initDatabase as importedInitDatabase,
    insertJobsIntoDatabase as importedInsertJobsIntoDatabase,
    fetchExistingJobs
} from './database.js';

// Log test function result
console.log('Test function result:', testFunction());

// Import the PostgreSQL client
import pg from 'pg';
const { Pool } = pg;

// Define database variables
let pool = null;

// Try to import the REST API module
let restModule = null;
try {
    restModule = await import('./database-rest.js');
    console.log('Successfully imported database-rest.js');
} catch (restError) {
    console.error('Failed to import database-rest.js:', restError.message);
}

// Default implementation of insertJobsIntoDatabase (used if both approaches fail)
let insertJobsIntoDatabase = async (jobs) => {
    console.log('Using dummy insertJobsIntoDatabase function');
    return 0;
};

// Initialize database function
async function initDatabase() {
    // First try the imported database.js implementation
    try {
        console.log('Trying imported database.js implementation...');
        const success = await importedInitDatabase();
        if (success) {
            console.log('Successfully connected using imported database.js!');
            // Use the imported implementation
            insertJobsIntoDatabase = importedInsertJobsIntoDatabase;
            return true;
        }
        console.log('Imported database.js approach failed, falling back to REST API...');
    } catch (error) {
        console.error('Error with imported database.js approach:', error.message);
        console.log('Falling back to REST API...');
    }

    // Next try the REST API approach if available
    if (restModule) {
        try {
            console.log('Trying REST API approach...');
            const success = await restModule.initDatabase();
            if (success) {
                console.log('Successfully connected using REST API!');
                // Use the REST API implementation
                insertJobsIntoDatabase = restModule.insertJobsIntoDatabase;
                return true;
            }
            console.log('REST API approach failed, falling back to dummy implementation...');
        } catch (error) {
            console.error('Error with REST API approach:', error.message);
            console.log('Falling back to dummy implementation...');
        }
    }

    // If all else fails, use the dummy implementation
    console.log('Using dummy initDatabase function');
    return false;
}

// Check for and remove URL unique constraint
async function checkAndRemoveUrlConstraint() {
    try {
        console.log('Checking for URL unique constraint...');

        // Check if the URL constraint exists
        const constraintCheck = await pool.query(`
            SELECT con.conname
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
            WHERE rel.relname = 'culinary_jobs_google'
            AND att.attname = 'url'
            AND con.contype = 'u';
        `);

        if (constraintCheck.rows.length > 0) {
            const constraintName = constraintCheck.rows[0].conname;
            console.log(`Found URL unique constraint: ${constraintName}`);

            // Drop the constraint
            console.log(`Removing URL unique constraint: ${constraintName}...`);
            await pool.query(`
                ALTER TABLE culinary_jobs_google
                DROP CONSTRAINT ${constraintName};
            `);

            console.log(`Successfully removed URL unique constraint: ${constraintName}`);

            // Create an index on URL instead (for performance but not uniqueness)
            console.log('Creating non-unique index on URL column...');
            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_google_url ON culinary_jobs_google(url);
            `);

            console.log('Successfully created non-unique index on URL column');
        } else {
            console.log('No URL unique constraint found - no action needed');

            // Check if the URL index exists
            const indexCheck = await pool.query(`
                SELECT indexname
                FROM pg_indexes
                WHERE tablename = 'culinary_jobs_google'
                AND indexname = 'idx_google_url';
            `);

            if (indexCheck.rows.length === 0) {
                console.log('Creating non-unique index on URL column...');
                await pool.query(`
                    CREATE INDEX IF NOT EXISTS idx_google_url ON culinary_jobs_google(url);
                `);
                console.log('Successfully created non-unique index on URL column');
            }
        }

        // Also check for email-company constraint
        const emailCompanyConstraintCheck = await pool.query(`
            SELECT con.conname
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            WHERE rel.relname = 'culinary_jobs_google'
            AND con.conname = 'culinary_jobs_google_email_company_key';
        `);

        if (emailCompanyConstraintCheck.rows.length > 0) {
            const constraintName = emailCompanyConstraintCheck.rows[0].conname;
            console.log(`Found email-company unique constraint: ${constraintName}`);

            // Drop the constraint
            console.log(`Removing email-company unique constraint: ${constraintName}...`);
            await pool.query(`
                ALTER TABLE culinary_jobs_google
                DROP CONSTRAINT ${constraintName};
            `);

            console.log(`Successfully removed email-company unique constraint: ${constraintName}`);
        }
    } catch (error) {
        console.error('Error checking or removing URL constraint:', error);
    }
}

// Check if tables exist and create them if needed
async function checkAndCreateTables() {
    try {
        console.log('Checking if required tables exist...');

        // Check if culinary_jobs_google table exists
        const jobsTableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'culinary_jobs_google'
            );
        `);

        const jobsTableExists = jobsTableCheck.rows[0].exists;
        console.log(`Table culinary_jobs_google exists: ${jobsTableExists}`);

        // Check and remove URL unique constraint if it exists
        if (jobsTableExists) {
            await checkAndRemoveUrlConstraint();
        }

        if (!jobsTableExists) {
            console.log('Creating culinary_jobs_google table...');
            await pool.query(`
                CREATE TABLE IF NOT EXISTS culinary_jobs_google (
                    id SERIAL PRIMARY KEY,
                    title VARCHAR(255) NOT NULL,
                    company VARCHAR(255) NOT NULL,
                    parent_company VARCHAR(255),
                    location VARCHAR(255),
                    salary VARCHAR(255),
                    contact_name VARCHAR(255),
                    contact_title VARCHAR(255),
                    email VARCHAR(255),
                    url TEXT,
                    job_details TEXT,
                    linkedin VARCHAR(255),
                    domain VARCHAR(255),
                    company_size VARCHAR(255),
                    date_added TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    contacts_last_viewed TIMESTAMP WITH TIME ZONE,
                    parent_url VARCHAR(255),

                    CONSTRAINT culinary_jobs_google_title_company_key UNIQUE (title, company)
                );

                CREATE INDEX IF NOT EXISTS idx_google_company_name ON culinary_jobs_google(company);
                CREATE INDEX IF NOT EXISTS idx_google_job_title ON culinary_jobs_google(title);
                CREATE INDEX IF NOT EXISTS idx_google_date_added ON culinary_jobs_google(date_added);
                CREATE INDEX IF NOT EXISTS idx_google_domain ON culinary_jobs_google(domain);
                CREATE INDEX IF NOT EXISTS idx_google_parent_company ON culinary_jobs_google(parent_company);
            `);
            console.log('Table culinary_jobs_google created successfully');
        }

        // Check if culinary_contacts_google table exists
        const contactsTableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'culinary_contacts_google'
            );
        `);

        const contactsTableExists = contactsTableCheck.rows[0].exists;
        console.log(`Table culinary_contacts_google exists: ${contactsTableExists}`);

        if (!contactsTableExists) {
            console.log('Creating culinary_contacts_google table...');
            await pool.query(`
                CREATE TABLE IF NOT EXISTS culinary_contacts_google (
                    id SERIAL PRIMARY KEY,
                    job_id INTEGER REFERENCES culinary_jobs_google(id) ON DELETE CASCADE,
                    name VARCHAR(255),
                    title VARCHAR(255),
                    email VARCHAR(255) NOT NULL,
                    date_added TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

                    CONSTRAINT unique_google_contact_email UNIQUE (job_id, email)
                );

                CREATE INDEX IF NOT EXISTS idx_google_contact_email ON culinary_contacts_google(email);
                CREATE INDEX IF NOT EXISTS idx_google_contact_job_id ON culinary_contacts_google(job_id);
                CREATE INDEX IF NOT EXISTS idx_google_contact_name ON culinary_contacts_google(name);
            `);
            console.log('Table culinary_contacts_google created successfully');
        }
    } catch (error) {
        console.error('Error checking or creating tables:', error);
    }
}

// Insert jobs into database function using PostgreSQL
async function insertJobsIntoDatabasePostgres(jobs) {
    if (!pool) {
        console.error('Database not initialized');
        return 0;
    }

    let insertedCount = 0;

    try {
        console.info(`Inserting ${jobs.length} jobs into the database...`);

        // Start a transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            for (const job of jobs) {
                try {
                    // Format salary as a string combining min and max
                    let salaryStr = '';
                    if (job.salary_min && job.salary_max) {
                        salaryStr = `${job.salary_min} - ${job.salary_max}`;
                        if (job.salary_currency) {
                            salaryStr = `${job.salary_currency} ${salaryStr}`;
                        }
                        if (job.salary_period) {
                            salaryStr = `${salaryStr} ${job.salary_period}`;
                        }
                    }

                    // Get the current timestamp for date fields
                    const now = new Date().toISOString();

                    // Get contact info from the first email if available
                    const contactName = job.emails && job.emails.length > 0 ?
                        `${job.emails[0].firstName || ''} ${job.emails[0].lastName || ''}`.trim() : '';
                    const contactTitle = job.emails && job.emails.length > 0 ? job.emails[0].position || '' : '';
                    const contactEmail = job.emails && job.emails.length > 0 ? job.emails[0].email || '' : '';

                    // Insert job data
                    const jobResult = await client.query(
                        `INSERT INTO culinary_jobs_google
                        (title, company, parent_company, location, salary, contact_name, contact_title, email,
                        url, job_details, linkedin, domain, company_size, date_added, last_updated, contacts_last_viewed, parent_url)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                        ON CONFLICT (title, company) DO UPDATE SET
                        location = EXCLUDED.location,
                        salary = EXCLUDED.salary,
                        contact_name = EXCLUDED.contact_name,
                        contact_title = EXCLUDED.contact_title,
                        email = EXCLUDED.email,
                        url = EXCLUDED.url,
                        job_details = EXCLUDED.job_details,
                        domain = EXCLUDED.domain,
                        last_updated = EXCLUDED.last_updated
                        RETURNING id, (xmax = 0) AS is_new`,
                        [
                            job.title,
                            job.company,
                            '', // parent_company
                            job.location,
                            salaryStr,
                            contactName,
                            contactTitle,
                            contactEmail,
                            job.apply_link,
                            job.description,
                            '', // linkedin
                            job.company_domain || '',
                            '', // company_size
                            now, // date_added
                            now, // last_updated
                            null, // contacts_last_viewed
                            '' // parent_url
                        ]
                    );

                    const jobId = jobResult.rows[0].id;
                    const isNewJob = jobResult.rows[0].is_new;

                    // Track job for email reporting
                    if (isNewJob) {
                        // This is a new job
                        jobStats.newJobs.push(job);
                        console.info(`Added NEW job: "${job.title}" at "${job.company}" (ID: ${jobId})`);
                    } else {
                        // This is a duplicate job
                        jobStats.skippedDuplicateJobs.push(job);
                        console.info(`Updated existing job: "${job.title}" at "${job.company}" (ID: ${jobId})`);
                    }

                    // Insert email contacts if available
                    if (job.emails && job.emails.length > 0) {
                        for (const email of job.emails) {
                            try {
                                // Combine first and last name
                                const fullName = `${email.firstName || ''} ${email.lastName || ''}`.trim();

                                await client.query(
                                    `INSERT INTO culinary_contacts_google
                                    (job_id, name, title, email, date_added, last_updated)
                                    VALUES ($1, $2, $3, $4, $5, $6)
                                    ON CONFLICT (job_id, email) DO UPDATE SET
                                    name = EXCLUDED.name,
                                    title = EXCLUDED.title,
                                    last_updated = EXCLUDED.last_updated`,
                                    [
                                        jobId,
                                        fullName,
                                        email.position || '',
                                        email.email,
                                        now,
                                        now
                                    ]
                                );
                            } catch (emailError) {
                                console.error(`Error inserting contact ${email.email}:`, emailError);
                            }
                        }
                        console.info(`Inserted ${job.emails.length} email contacts for job ID ${jobId}`);
                    }

                    insertedCount++;
                    console.info(`Inserted job: "${job.title}" at "${job.company}" (ID: ${jobId})`);
                } catch (error) {
                    console.error(`Error processing job "${job.title}" at "${job.company}":`, error);
                }
            }

            // Commit the transaction
            await client.query('COMMIT');
            console.info(`Successfully committed transaction with ${insertedCount} jobs.`);
        } catch (error) {
            // Rollback the transaction on error
            await client.query('ROLLBACK');
            console.error('Transaction failed, rolling back:', error);
        } finally {
            // Release the client back to the pool
            client.release();
        }

        console.info(`Successfully inserted ${insertedCount} jobs into the database.`);
        return insertedCount;
    } catch (error) {
        console.error('Error during database insertion:', error);
        return insertedCount;
    }
}

// Store testMode in a variable accessible throughout the file
let isTestMode = false;

// Initialize the Apify Actor
await Actor.init();

// Track job statistics for email reporting
const jobStats = {
    startTime: new Date(),
    endTime: null,
    durationMinutes: 0,
    durationSeconds: 0,
    processedCount: 0,
    newJobs: [],
    skippedDuplicateJobs: [],
    skippedExcludedJobs: [],
    queries: []
};

try {
    console.log('Starting Google Jobs API Actor...');

    // Get input from the user
    const input = await Actor.getInput() || {};

    // Define the top 60 largest US cities for targeted job searches
    const topCities = [
        'New York NY', 'Los Angeles CA', 'Chicago IL', 'Houston TX', 'Phoenix AZ',
        'Philadelphia PA', 'San Antonio TX', 'San Diego CA', 'Dallas TX', 'San Jose CA',
        'Austin TX', 'Jacksonville FL', 'Fort Worth TX', 'Columbus OH', 'Indianapolis IN',
        'Charlotte NC', 'San Francisco CA', 'Seattle WA', 'Nashville TN', 'Denver CO',
        'Oklahoma City OK', 'El Paso TX', 'Boston MA', 'Portland OR', 'Las Vegas NV',
        'Detroit MI', 'Memphis TN', 'Louisville KY', 'Baltimore MD', 'Milwaukee WI',
        'Albuquerque NM', 'Tucson AZ', 'Fresno CA', 'Sacramento CA', 'Kansas City MO',
        'Mesa AZ', 'Atlanta GA', 'Omaha NE', 'Colorado Springs CO', 'Raleigh NC',
        'Long Beach CA', 'Virginia Beach VA', 'Miami FL', 'Oakland CA', 'Minneapolis MN',
        'Tulsa OK', 'Bakersfield CA', 'Wichita KS', 'Arlington TX', 'Aurora CO',
        'Tampa FL', 'New Orleans LA', 'Cleveland OH', 'Honolulu HI', 'Anaheim CA',
        'Lexington KY', 'Stockton CA', 'Corpus Christi TX', 'Henderson NV', 'Riverside CA'
    ];

    // Define generic search terms; city is applied via the location parameter
    const defaultQueries = [
        'restaurant management jobs',
        'hotel management jobs',
        'hotel chef jobs',
        'restaurant chef jobs',
        'restaurant corporate office jobs',
        'restaurant executive jobs',
        'restaurant director jobs',
        'private chef jobs'
    ];

    // Extract input parameters with defaults
    const {
        queries = defaultQueries,
        maxPagesPerQuery = 40,
        location = '',
        saveToDataset = true,
        pushToDatabase: inputPushToDatabase = true,
        databaseUrl = process.env.DATABASE_URL ? process.env.DATABASE_URL.replace('DATABASE_URL=', '') : '', // Remove DATABASE_URL= prefix if present
        databaseTable = 'culinary_jobs_google',
        deduplicateJobs = true,

        excludeFastFood = true,
        excludeRecruiters = true,
        includeWebsiteData = false,
        testMode = false,
        searchEngine = 'both',

        // New inputs to support city-by-city searches
        useTopCities = true,
        cities = []
    } = input;

    // Update the global isTestMode variable
    isTestMode = testMode;

    // Log environment configuration
    console.log('Environment Configuration:');
    console.log(`- NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
    console.log(`- Database URL: ${databaseUrl ? 'Set' : 'Not set'}`);
    console.log(`- Supabase URL: ${process.env.SUPABASE_URL ? 'Set' : 'Not set'}`);

    // Store queries in job stats
    jobStats.queries = [...queries];

    // Website data collection enabled (email enrichment handled by web viewer)
    const forceWebsiteData = true;

    // Force database integration to be enabled
    const forcePushToDatabase = true;

    // Number of jobs to process in test mode (only used when testMode is true)
    const testModeLimit = 5;

    console.log('Google Jobs API Actor configuration:');
    console.log(`- Search Engine: ${searchEngine}`);
    console.log(`- Queries: ${queries.join(', ')}`);
    console.log(`- Max pages per query: ${maxPagesPerQuery}`);
    // Determine city list to use
    const locationsToSearch = (Array.isArray(cities) && cities.length > 0)
        ? cities
        : (useTopCities ? topCities : (location ? [location] : []));
    console.log(`- Location filter: ${location || 'None'}${locationsToSearch.length > 0 ? ` (expanded by ${locationsToSearch.length} city/cities)` : ''}`);

    console.log(`- Exclude fast food: ${excludeFastFood}`);
    console.log(`- Exclude recruiters: ${excludeRecruiters}`);
    console.log(`- Include website data: ${forceWebsiteData} (URL collection enabled, email enrichment handled by web viewer)`);
    console.log(`- Save to dataset: ${saveToDataset}`);
    console.log(`- Push to database: ${forcePushToDatabase} (forced to true)`);
    // Always show database info since forcePushToDatabase is always true
    console.log(`- Database table: ${databaseTable}`);
    console.log(`- Deduplicate jobs: ${deduplicateJobs}`);
    console.log(`- Test mode: ${testMode}${testMode ? ` (limit: ${testModeLimit} jobs per query, email only to aj@chefsheet.com)` : ''}`);

    let totalJobsFound = 0;
    let totalJobsProcessed = 0;
    let totalJobsSaved = 0;

    // In test mode, only process the first query
    const queriesToProcess = testMode ? queries.slice(0, 1) : queries;
    console.log(`Processing ${queriesToProcess.length} queries${testMode ? ' (test mode - only first query)' : ''}`);

    // Ensure city is central: strip broad country terms from query text
    function sanitizeQueryForLocation(originalQuery) {
        if (!originalQuery || typeof originalQuery !== 'string') return originalQuery;
        return originalQuery
            .replace(/\b(united states|usa|u\.s\.a\.|u\.s\.)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Process each query
    for (const query of queriesToProcess) {
        const baseQuery = sanitizeQueryForLocation(query);
        // In test mode, process enough pages to get our target number of jobs
        // Start with 1 page, but allow up to 3 pages in test mode if needed
        const pagesToProcess = testMode ? 3 : maxPagesPerQuery;

        // Set database connection environment variables
        if (databaseUrl) {
            console.log(`Using provided database URL: ${databaseUrl.substring(0, 20)}...`);

            // Ensure the URL has the correct format for query parameters
            if (databaseUrl.includes('&family=4') && !databaseUrl.includes('?family=4')) {
                databaseUrl = databaseUrl.replace('&family=4', '?family=4');
                console.log('Fixed database URL format for query parameters');
            }

            process.env.DATABASE_URL = databaseUrl;
        } else if (!process.env.DATABASE_URL) {
            // Use the new database user credentials
            const dbUser = 'google_scraper';
            const dbPassword = 'Relham12?';

            // Try different connection strings with direct IP addresses
            const connectionOptions = [
                // Option 1: Direct database with IP address using new user (IPv4 only)
                `postgresql://${dbUser}:${encodeURIComponent(dbPassword)}@34.102.106.226:5432/postgres?family=4`,

                // Option 2: AWS US West 1 pooler with IP address using new user (IPv4 only)
                `postgresql://${dbUser}:${encodeURIComponent(dbPassword)}@3.101.124.236:6543/postgres?family=4`,

                // Option 3: Original hostname with new user (as fallback)
                `postgresql://${dbUser}:${encodeURIComponent(dbPassword)}@db.mbaqiwhkngfxxmlkionj.supabase.co:5432/postgres?family=4`
            ];

            console.log('Available connection options:');
            connectionOptions.forEach((option, index) => {
                console.log(`- Option ${index + 1}: ${option.replace(/:[^:@]+@/, ':***@')}`);
            });

            // Use the first option by default
            console.log('No database URL provided. Using default DATABASE_URL with new user credentials.');
            process.env.DATABASE_URL = connectionOptions[0];
        } else {
            console.log('Using environment DATABASE_URL variable.');

            // Ensure the URL has the correct format for query parameters
            if (process.env.DATABASE_URL.includes('&family=4') && !process.env.DATABASE_URL.includes('?family=4')) {
                process.env.DATABASE_URL = process.env.DATABASE_URL.replace('&family=4', '?family=4');
                console.log('Fixed environment DATABASE_URL format for query parameters');
            }
        }

        // Fix the DATABASE_URL format if needed
        if (process.env.DATABASE_URL) {
            // First encode any special characters in the password
            const urlParts = process.env.DATABASE_URL.split('@');
            if (urlParts.length === 2) {
                const authParts = urlParts[0].split(':');
                if (authParts.length === 3) {
                    const password = authParts[2];
                    const encodedPassword = encodeURIComponent(password);
                    process.env.DATABASE_URL = `${authParts[0]}:${authParts[1]}:${encodedPassword}@${urlParts[1]}`;
                }
            }

            // Fix query parameter format
            if (process.env.DATABASE_URL.includes('/postgres&')) {
                process.env.DATABASE_URL = process.env.DATABASE_URL.replace('/postgres&', '/postgres?');
            }
        }

        // Initialize the database connection
        const dbInitialized = await initDatabase();

        // If database connection fails, try the REST API approach
        if (!dbInitialized) {
            console.error('Direct database connection failed. Trying REST API approach...');
            console.log('Trying REST API approach...');

            // Here we would implement the REST API approach, but for now we'll just fail
            console.error('REST API approach not fully implemented. Cannot continue.');
            throw new Error('Database connection failed. Cannot continue without database access.');
        }

        // Fetch existing jobs from the database to avoid unnecessary API calls
        let existingJobs = new Map();

        try {
            console.log('Fetching existing jobs from the database to optimize API calls...');

            // Fix the DATABASE_URL format again just to be sure
            if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('/postgres&')) {
                console.log('Fixing DATABASE_URL format again: replacing /postgres& with /postgres?');
                process.env.DATABASE_URL = process.env.DATABASE_URL.replace('/postgres&', '/postgres?');
            }

            existingJobs = await fetchExistingJobs();
            console.log(`Fetched ${existingJobs.size} existing jobs from the database for optimization`);

            // If we can't fetch existing jobs, that's a critical error
            if (existingJobs.size === 0) {
                console.error('Failed to fetch existing jobs from database. This is required for optimization.');
                throw new Error('Failed to fetch existing jobs from database. Cannot continue without this data.');
            }
        } catch (error) {
            console.error('Error fetching existing jobs:', error);
            throw new Error('Failed to fetch existing jobs from database. Cannot continue without this data.');
        }

        // Search for jobs based on selected search engine, expanded by city if configured
        let jobs = [];

        if (locationsToSearch.length > 0) {
            console.log(`Executing city-by-city search for "${baseQuery}" across ${locationsToSearch.length} cities...`);
            const aggregatedJobs = [];

            for (const city of locationsToSearch) {
                try {
                    if (searchEngine === 'google') {
                        console.log(`Searching (Google) for: "${baseQuery}" in "${city}"`);
                        const cityJobs = await searchAllJobs(baseQuery, city, pagesToProcess, existingJobs);
                        aggregatedJobs.push(...cityJobs);
                    } else if (searchEngine === 'bing') {
                        console.log(`Searching (Bing) for: "${baseQuery}" in "${city}"`);
                        const bingResults = testMode ? 20 : 100;
                        const cityJobs = await searchAllJobsWithBing([baseQuery], city, bingResults, existingJobs);
                        aggregatedJobs.push(...cityJobs);
                    } else if (searchEngine === 'both') {
                        console.log(`Searching (Both) for: "${baseQuery}" in "${city}"`);
                        const googleJobs = await searchAllJobs(baseQuery, city, pagesToProcess, existingJobs);
                        const bingResults = testMode ? 20 : 100;
                        const bingJobs = await searchAllJobsWithBing([baseQuery], city, bingResults, existingJobs);
                        const combined = [...googleJobs, ...bingJobs];
                        aggregatedJobs.push(...combined);
                    }
                } catch (cityErr) {
                    console.error(`Error searching city "${city}" for query "${baseQuery}": ${cityErr.message}`);
                }
            }

            // Deduplicate across all cities by title+company
            const jobMap = new Map();
            for (const job of aggregatedJobs) {
                const key = `${job.title.toLowerCase()}|${job.company.toLowerCase()}`;
                if (!jobMap.has(key)) jobMap.set(key, job);
            }
            jobs = Array.from(jobMap.values());
            console.log(`City-expanded results for "${baseQuery}": ${aggregatedJobs.length} raw, ${jobs.length} after de-dup`);
        } else {
            if (searchEngine === 'google') {
                console.log(`Searching for jobs with Google Jobs API: "${baseQuery}" (${testMode ? 'test mode - up to 3 pages' : `up to ${pagesToProcess} pages`}) with database optimization`);
                jobs = await searchAllJobs(baseQuery, location, pagesToProcess, existingJobs);
            } else if (searchEngine === 'bing') {
                console.log(`Searching for jobs with Bing Search API: "${baseQuery}" (${testMode ? 'test mode' : 'full search'}) with database optimization`);
                const bingResults = testMode ? 20 : 100; // No practical limit, best filtering
                jobs = await searchAllJobsWithBing([baseQuery], location, bingResults, existingJobs);
            } else if (searchEngine === 'both') {
                console.log(`Searching for jobs with both Google Jobs API and Bing Search API: "${baseQuery}"`);

                // Search with Google Jobs first
                console.log(`Google search for: "${baseQuery}"`);
                const googleJobs = await searchAllJobs(baseQuery, location, pagesToProcess, existingJobs);

                // Search with Bing
                console.log(`Bing search for: "${baseQuery}"`);
                const bingResults = testMode ? 20 : 100;
                const bingJobs = await searchAllJobsWithBing([baseQuery], location, bingResults, existingJobs);

                // Combine results and deduplicate
                const combinedJobs = [...googleJobs, ...bingJobs];
                const jobMap = new Map();

                // Deduplicate by title + company combination
                for (const job of combinedJobs) {
                    const key = `${job.title.toLowerCase()}|${job.company.toLowerCase()}`;
                    if (!jobMap.has(key)) {
                        jobMap.set(key, job);
                    } else {
                        console.info(`Deduplicating job: "${job.title}" at "${job.company}" (found in both Google and Bing)`);
                    }
                }

                jobs = Array.from(jobMap.values());
                console.log(`Combined search results: ${googleJobs.length} from Google + ${bingJobs.length} from Bing = ${combinedJobs.length} total, ${jobs.length} after deduplication`);
            }
        }

        if (jobs.length === 0) {
            console.log(`No jobs found for query: "${query}"`);
            continue;
        }

        console.log(`Found ${jobs.length} jobs for query: "${query}"`);
        totalJobsFound += jobs.length;

        // In test mode, only process a limited number of jobs
        const jobsToProcess = testMode ? jobs.slice(0, testModeLimit) : jobs;
        console.log(`Processing ${jobsToProcess.length} jobs${testMode ? ` (test mode - limit: ${testModeLimit})` : ''}`);

        // Log the jobs we're processing
        if (testMode) {
            console.log('Jobs being processed:');
            jobsToProcess.forEach((job, index) => {
                console.log(`Job #${index + 1}: "${job.title}" at "${job.company}" in "${job.location}"`);
            });
        }

        // Process jobs for database insertion
        // Website data collection disabled (email enrichment handled by web viewer)
        console.log(`Processing ${jobsToProcess.length} jobs for database insertion...`);
        const processedJobs = await processJobsForDatabase(jobsToProcess, forceWebsiteData);

        // Track excluded jobs for email reporting
        const excludedJobs = jobsToProcess.filter(job => job._exclusionReason);
        jobStats.skippedExcludedJobs.push(...excludedJobs);

        // Track jobs that were skipped because they already exist in the database
        const existingDbJobs = jobsToProcess.filter(job => job._existsInDatabase);
        if (existingDbJobs.length > 0) {
            console.log(`Found ${existingDbJobs.length} jobs that already exist in the database`);
            jobStats.skippedDuplicateJobs.push(...existingDbJobs);
        }

        // Update job processing count
        totalJobsProcessed += processedJobs.length;
        jobStats.processedCount += processedJobs.length;

        // Save to Apify dataset if requested
        if (saveToDataset) {
            await Actor.pushData(processedJobs);
            console.log(`Saved ${processedJobs.length} jobs to Apify dataset`);
            totalJobsSaved += processedJobs.length;
        }

        // Display job data in logs
        console.log(`\n=== Job Data for Query: "${query}" ===`);
        console.log(`Found ${processedJobs.length} jobs after filtering`);

        // Display a summary of each job
        processedJobs.forEach((job, index) => {
            console.log(`\nJob #${index + 1}:`);
            console.log(`Title: ${job.title}`);
            console.log(`Company: ${job.company}`);
            console.log(`Location: ${job.location}`);
            console.log(`Posted: ${job.posted_at}`);
            console.log(`Schedule: ${job.schedule}`);
            console.log(`Experience Level: ${job.experience_level}`);

            // Display salary information if available
            if (job.salary_min || job.salary_max) {
                const salaryMin = job.salary_min ? `$${job.salary_min.toLocaleString()}` : 'Not specified';
                const salaryMax = job.salary_max ? `$${job.salary_max.toLocaleString()}` : 'Not specified';
                console.log(`Salary: ${salaryMin}${job.salary_max ? ` - ${salaryMax}` : ''} ${job.salary_period}`);
            } else {
                console.log(`Salary: Not specified`);
            }

            // Display skills if available
            if (job.skills && job.skills.length > 0) {
                console.log(`Skills: ${job.skills.join(', ')}`);
            } else {
                console.log(`Skills: None detected`);
            }

            // Display apply link
            console.log(`Apply Link: ${job.apply_link}`);

            // Display company website and domain if available
            if (job.company_website) {
                console.log(`Company Website: ${job.company_website}`);
            }
            if (job.company_domain) {
                console.log(`Company Domain: ${job.company_domain}`);
            }

            // Display emails if available
            if (job.emails && job.emails.length > 0) {
                console.log(`Emails Found: ${job.emails.length}`);
                // Display up to 20 emails
                job.emails.slice(0, 20).forEach((email, idx) => {
                    console.log(`  Email #${idx+1}: ${email.email} (${email.firstName || ''} ${email.lastName || ''})${email.position ? ` - ${email.position}` : ''}`);
                });
            }

            // Display a short excerpt of the description
            const shortDescription = job.description.length > 150
                ? job.description.substring(0, 150) + '...'
                : job.description;
            console.log(`Description: ${shortDescription}`);
        });

        console.log(`\n=== End of Job Data for Query: "${query}" ===`);

        // Database integration - always enabled
        if (forcePushToDatabase) {
            console.log(`Pushing ${processedJobs.length} jobs to database...`);

            // Database connection should already be initialized
            if (dbInitialized) {
                // Insert jobs into the database
                const dbResult = await insertJobsIntoDatabase(processedJobs);
                console.log(`Successfully inserted/updated ${dbResult.insertedCount} jobs into the database (${databaseTable}).`);

                // Update job statistics for email reporting
                jobStats.newJobs.push(...dbResult.newJobs);
                jobStats.skippedDuplicateJobs.push(...dbResult.updatedJobs);

                console.log(`Database results: ${dbResult.newJobs.length} new jobs, ${dbResult.updatedJobs.length} updated jobs`);
            } else {
                console.error(`Failed to initialize database connection. Please check your database credentials.`);
                console.error(`Make sure to set DATABASE_URL or all SUPABASE_* environment variables in the Apify console.`);
            }
        }

        // Add a delay between queries to avoid rate limits
        if (queries.indexOf(query) < queries.length - 1) {
            console.log('Waiting 5 seconds before next query...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    console.log(`Google Jobs API Actor completed.`);
    console.log(`Found ${totalJobsFound} jobs, processed ${totalJobsProcessed} jobs, saved ${totalJobsSaved} jobs.`);

} catch (error) {
    console.error(`Error in Google Jobs API Actor: ${error.message}`);
    throw error;
} finally {
    // Calculate end time and duration
    jobStats.endTime = new Date();
    const durationMs = jobStats.endTime - jobStats.startTime;
    jobStats.durationSeconds = Math.round(durationMs / 1000);
    jobStats.durationMinutes = Math.round(durationMs / 60000 * 10) / 10; // Round to 1 decimal place

    console.log(`\nJob Statistics:`);
    console.log(`- Start time: ${jobStats.startTime.toISOString()}`);
    console.log(`- End time: ${jobStats.endTime.toISOString()}`);
    console.log(`- Duration: ${jobStats.durationMinutes} minutes (${jobStats.durationSeconds} seconds)`);
    console.log(`- Jobs processed: ${jobStats.processedCount}`);
    console.log(`- New jobs: ${jobStats.newJobs.length}`);
    console.log(`- Skipped duplicates: ${jobStats.skippedDuplicateJobs.length}`);
    console.log(`- Skipped exclusions: ${jobStats.skippedExcludedJobs.length}`);

    // Send completion email
    try {
        console.log('\n=== SENDING COMPLETION EMAIL ===');
        console.log('Email configuration:');
        console.log(`- Test mode: ${isTestMode}`);
        console.log(`- Job stats: ${jobStats.processedCount} jobs processed, ${jobStats.newJobs.length} new, ${jobStats.skippedDuplicateJobs.length} duplicates, ${jobStats.skippedExcludedJobs.length} excluded`);

        // Pass the isTestMode parameter to the email function
        const emailSent = await sendCompletionEmail(jobStats, isTestMode);
        console.log(`Email sending ${emailSent ? 'successful' : 'failed'}`);
        console.log('=== END OF EMAIL SENDING ===\n');
    } catch (emailError) {
        console.error('Error sending completion email:', emailError);
        if (emailError.stack) {
            console.error('Stack trace:', emailError.stack);
        }
    }

    await Actor.exit();
}

/**
 * Google Jobs API Actor
 *
 * This actor uses the SearchAPI.io Google Jobs API to search for job listings
 * and save them to a dataset or push them to a database.
 */
import { Actor } from 'apify';
import { searchAllJobs, processJobsForDatabase } from './google_jobs_api.js';
import { testFunction } from './test.js';

// Log test function result
console.log('Test function result:', testFunction());

// Import the PostgreSQL client
import pg from 'pg';
const { Pool } = pg;

// Define database variables
let pool = null;

// Initialize database function
async function initDatabase() {
    try {
        console.log('Initializing PostgreSQL database connection...');

        // Get database connection string
        const connectionString = process.env.DATABASE_URL;

        if (!connectionString) {
            console.error('No DATABASE_URL environment variable found');
            return false;
        }

        console.log(`Using DATABASE_URL: ${connectionString.substring(0, 20)}...`);

        // Create a connection pool
        pool = new Pool({
            connectionString,
            ssl: {
                rejectUnauthorized: false
            },
            // Force IPv4 to avoid connectivity issues
            family: 4
        });

        // Test the connection
        const result = await pool.query('SELECT NOW()');
        console.log('Successfully connected to PostgreSQL!');
        console.log(`Server time: ${result.rows[0].now}`);

        // Check if tables exist and create them if needed
        await checkAndCreateTables();

        return true;
    } catch (error) {
        console.error('Failed to connect to PostgreSQL:', error);

        // Provide more detailed error information
        if (error.code === 'ENOTFOUND') {
            console.error(`Could not resolve hostname: ${error.hostname}`);
            console.error('Please check your DATABASE_URL for typos in the hostname.');
        } else if (error.code === 'ECONNREFUSED') {
            console.error(`Connection refused at ${error.address}:${error.port}`);
            console.error('Please check if the port is correct and if the database server is accepting connections.');
        } else if (error.code === '28P01') {
            console.error('Authentication failed. Please check your username and password.');
        } else if (error.code === '3D000') {
            console.error('Database does not exist. Please check the database name in your connection string.');
        }

        return false;
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

// Insert jobs into database function
async function insertJobsIntoDatabase(jobs) {
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
                        RETURNING id`,
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

// Initialize the Apify Actor
await Actor.init();

try {
    console.log('Starting Google Jobs API Actor...');

    // Get input from the user
    const input = await Actor.getInput() || {};
    // Extract input parameters with defaults
    const {
        queries = [
            'restaurant chefs united states',
            'restaurant managers united states',
            'hotel chefs united states',
            'hotel managers united states',
            'private chefs united states',
            'household chefs united states',
            'restaurant executives united states',
            'hotel executives united states'
        ],
        maxPagesPerQuery = 10, // Increased from 5 to 10 to get more jobs
        location = '',
        saveToDataset = true,
        // Read pushToDatabase from input but we'll force it to true below
        pushToDatabase: inputPushToDatabase = true,
        databaseUrl = '',
        databaseTable = 'culinary_jobs_google',
        deduplicateJobs = true,
        fullTimeOnly = true,
        excludeFastFood = true,
        excludeRecruiters = true,
        // Default is true, but we'll force it to true below
        includeHunterData = true
    } = input;

    // Force Hunter.io integration to be enabled
    const forceHunterData = true;

    // Force database integration to be enabled
    const forcePushToDatabase = true;

    // Test mode - set to false to process all jobs
    const testMode = false;
    // Number of jobs to process in test mode (only used when testMode is true)
    const testModeLimit = 5;

    console.log('Google Jobs API Actor configuration:');
    console.log(`- Queries: ${queries.join(', ')}`);
    console.log(`- Max pages per query: ${maxPagesPerQuery}`);
    console.log(`- Location filter: ${location || 'None'}`);
    console.log(`- Full-time only: ${fullTimeOnly}`);
    console.log(`- Exclude fast food: ${excludeFastFood}`);
    console.log(`- Exclude recruiters: ${excludeRecruiters}`);
    console.log(`- Include Hunter.io data: ${forceHunterData} (forced to true)`);
    console.log(`- Save to dataset: ${saveToDataset}`);
    console.log(`- Push to database: ${forcePushToDatabase} (forced to true)`);
    // Always show database info since forcePushToDatabase is always true
    console.log(`- Database table: ${databaseTable}`);
    console.log(`- Deduplicate jobs: ${deduplicateJobs}`);
    console.log(`- Test mode: ${testMode}${testMode ? ` (limit: ${testModeLimit} jobs)` : ''}`);

    let totalJobsFound = 0;
    let totalJobsProcessed = 0;
    let totalJobsSaved = 0;

    // In test mode, only process the first query
    const queriesToProcess = testMode ? queries.slice(0, 1) : queries;
    console.log(`Processing ${queriesToProcess.length} queries${testMode ? ' (test mode - only first query)' : ''}`);

    // Process each query
    for (const query of queriesToProcess) {
        // In test mode, process enough pages to get our target number of jobs
        // Start with 1 page, but allow up to 3 pages in test mode if needed
        const pagesToProcess = testMode ? 3 : maxPagesPerQuery;
        console.log(`Searching for jobs with query: "${query}" (${testMode ? 'test mode - up to 3 pages' : `up to ${pagesToProcess} pages`})`);

        // Search for jobs
        const jobs = await searchAllJobs(query, location, pagesToProcess);

        if (jobs.length === 0) {
            console.log(`No jobs found for query: "${query}"`);
            continue;
        }

        console.log(`Found ${jobs.length} jobs for query: "${query}"`);
        totalJobsFound += jobs.length;

        // Filter for full-time positions if requested
        let filteredJobs = jobs;
        if (fullTimeOnly) {
            filteredJobs = jobs.filter(job =>
                job.schedule === 'Full-time' ||
                (job.extensions && job.extensions.some(ext => ext.includes('Full-time')))
            );
            console.log(`Filtered to ${filteredJobs.length} full-time positions out of ${jobs.length} total jobs`);
        }

        // In test mode, only process a limited number of jobs
        const jobsToProcess = testMode ? filteredJobs.slice(0, testModeLimit) : filteredJobs;
        console.log(`Processing ${jobsToProcess.length} jobs${testMode ? ` (test mode - limit: ${testModeLimit})` : ''}`);

        // Log the jobs we're processing
        if (testMode) {
            console.log('Jobs being processed:');
            jobsToProcess.forEach((job, index) => {
                console.log(`Job #${index + 1}: "${job.title}" at "${job.company}" in "${job.location}"`);
            });
        }

        // Process jobs for database insertion
        // Always use forceHunterData (which is true) instead of includeHunterData
        const processedJobs = await processJobsForDatabase(jobsToProcess, forceHunterData);
        totalJobsProcessed += processedJobs.length;

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

            // Set database connection environment variables
            if (databaseUrl) {
                console.log(`Using provided database URL: ${databaseUrl.substring(0, 20)}...`);
                process.env.DATABASE_URL = databaseUrl;
            } else if (!process.env.DATABASE_URL) {
                // Set default DATABASE_URL using the service role key
                const serviceRoleKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1iYXFpd2hrbmdmeHhtbGtpb25qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NDE0MzUzMiwiZXhwIjoyMDU5NzE5NTMyfQ.7fdYmDgf_Ik1xtABnNje5peczWjoFKhvrvokPRFknzE';
                const defaultDbUrl = `postgresql://postgres.${serviceRoleKey}@db.mbaqiwhkngfxxmlkionj.supabase.co:5432/postgres`;
                console.log('No database URL provided. Using default DATABASE_URL.');
                process.env.DATABASE_URL = defaultDbUrl;
            } else {
                console.log('Using environment DATABASE_URL variable.');
            }

            // Initialize the database connection
            const dbInitialized = await initDatabase();

            if (dbInitialized) {
                // Insert jobs into the database
                const insertedCount = await insertJobsIntoDatabase(processedJobs);
                console.log(`Successfully inserted ${insertedCount} jobs into the database (${databaseTable}).`);
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
    await Actor.exit();
}

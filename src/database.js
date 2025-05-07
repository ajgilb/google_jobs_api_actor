/**
 * Database integration for Google Jobs API Actor
 * Handles connections to Supabase PostgreSQL database and data insertion
 */

import pg from 'pg';
const { Pool } = pg;

// Database configuration - using individual Supabase environment variables
const supabaseUser = process.env.SUPABASE_USER || 'postgres.mbaqiwhkngfxxmlkionj';
const supabasePassword = process.env.SUPABASE_PASSWORD || 'Relham12?';
const supabaseHost = process.env.SUPABASE_HOST || 'aws-0-us-west-1.pooler.supabase.com';
const supabasePort = process.env.SUPABASE_PORT || '6543';
const supabaseDatabase = process.env.SUPABASE_DATABASE || 'postgres';

// Build connection string from environment variables or use DATABASE_URL if provided
const connectionString = process.env.DATABASE_URL ||
    `postgresql://${supabaseUser}:${encodeURIComponent(supabasePassword)}@${supabaseHost}:${supabasePort}/${supabaseDatabase}`;

let pool = null;

/**
 * Initializes the database connection pool
 * @returns {Promise<boolean>} - True if connection is successful
 */
async function initDatabase() {
    if (!connectionString) {
        console.error('No database connection string available');
        return false;
    }

    try {
        // Log which environment variables are being used
        console.info('Using Supabase configuration:');
        console.info(`- Host: ${supabaseHost}`);
        console.info(`- Port: ${supabasePort}`);
        console.info(`- Database: ${supabaseDatabase}`);
        console.info(`- User: ${supabaseUser}`);
        // Don't log the password for security reasons

        // Initialize the connection pool
        pool = new Pool({
            connectionString,
            ssl: {
                rejectUnauthorized: false
            }
        });

        // Add error handler for the pool
        pool.on('error', (err) => {
            console.error('Unexpected error on idle client', err);
        });

        // Test the connection
        const result = await pool.query('SELECT NOW()');
        console.info('Successfully connected to Supabase PostgreSQL database:', result.rows[0].now);

        return true;
    } catch (error) {
        console.error('Failed to connect to database:', error);
        return false;
    }
}

/**
 * Creates the necessary database tables if they don't exist
 */
async function createTables() {
    const client = await pool.connect();
    try {
        // Create the jobs table
        await client.query(`
            CREATE TABLE IF NOT EXISTS culinary_jobs_google (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                company VARCHAR(255) NOT NULL,
                location VARCHAR(255),
                posted_at VARCHAR(255),
                schedule VARCHAR(255),
                description TEXT,
                salary_min NUMERIC,
                salary_max NUMERIC,
                salary_currency VARCHAR(10),
                salary_period VARCHAR(20),
                skills TEXT[],
                experience_level VARCHAR(50),
                apply_link TEXT,
                source VARCHAR(255),
                scraped_at TIMESTAMP WITH TIME ZONE,
                company_website TEXT,
                company_domain VARCHAR(255),
                date_added TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

                CONSTRAINT unique_job_apply_link UNIQUE (apply_link)
            );

            -- Add indexes for performance
            CREATE INDEX IF NOT EXISTS idx_google_company_name ON culinary_jobs_google(company);
            CREATE INDEX IF NOT EXISTS idx_google_job_title ON culinary_jobs_google(title);
            CREATE INDEX IF NOT EXISTS idx_google_date_added ON culinary_jobs_google(date_added);
        `);

        // Create the contacts table
        await client.query(`
            CREATE TABLE IF NOT EXISTS culinary_contacts_google (
                id SERIAL PRIMARY KEY,
                job_id INTEGER REFERENCES culinary_jobs_google(id) ON DELETE CASCADE,
                email VARCHAR(255) NOT NULL,
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                position VARCHAR(255),
                confidence INTEGER,
                company VARCHAR(255),
                domain VARCHAR(255),
                date_added TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

                CONSTRAINT unique_google_contact_email UNIQUE (job_id, email)
            );

            -- Add indexes for performance
            CREATE INDEX IF NOT EXISTS idx_google_contact_email ON culinary_contacts_google(email);
            CREATE INDEX IF NOT EXISTS idx_google_contact_job_id ON culinary_contacts_google(job_id);
        `);
    } catch (error) {
        console.error('Error creating database tables:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Inserts job data into the database
 * @param {Array} jobs - Array of job objects to insert
 * @returns {Promise<number>} - Number of jobs successfully inserted
 */
async function insertJobsIntoDatabase(jobs) {
    if (!pool) {
        console.error('Database not initialized');
        return 0;
    }

    const client = await pool.connect();
    let insertedCount = 0;

    try {
        await client.query('BEGIN');
        console.info('Starting database transaction (BEGIN).');

        for (const job of jobs) {
            try {
                // Insert job data
                const jobResult = await client.query(`
                    INSERT INTO culinary_jobs_google (
                        title, company, location, posted_at, schedule, description,
                        salary_min, salary_max, salary_currency, salary_period,
                        skills, experience_level, apply_link, source, scraped_at,
                        company_website, company_domain
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                    ON CONFLICT (apply_link) DO UPDATE SET
                        title = EXCLUDED.title,
                        company = EXCLUDED.company,
                        location = EXCLUDED.location,
                        posted_at = EXCLUDED.posted_at,
                        schedule = EXCLUDED.schedule,
                        description = EXCLUDED.description,
                        salary_min = EXCLUDED.salary_min,
                        salary_max = EXCLUDED.salary_max,
                        salary_currency = EXCLUDED.salary_currency,
                        salary_period = EXCLUDED.salary_period,
                        skills = EXCLUDED.skills,
                        experience_level = EXCLUDED.experience_level,
                        source = EXCLUDED.source,
                        scraped_at = EXCLUDED.scraped_at,
                        company_website = EXCLUDED.company_website,
                        company_domain = EXCLUDED.company_domain,
                        last_updated = CURRENT_TIMESTAMP
                    RETURNING id
                `, [
                    job.title,
                    job.company,
                    job.location,
                    job.posted_at,
                    job.schedule,
                    job.description,
                    job.salary_min,
                    job.salary_max,
                    job.salary_currency,
                    job.salary_period,
                    job.skills,
                    job.experience_level,
                    job.apply_link,
                    job.source,
                    job.scraped_at,
                    job.company_website,
                    job.company_domain
                ]);

                const jobId = jobResult.rows[0].id;

                // Insert email contacts if available
                if (job.emails && job.emails.length > 0) {
                    for (const email of job.emails) {
                        await client.query(`
                            INSERT INTO culinary_contacts_google (
                                job_id, email, first_name, last_name, position, confidence, company, domain
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            ON CONFLICT (job_id, email) DO UPDATE SET
                                first_name = EXCLUDED.first_name,
                                last_name = EXCLUDED.last_name,
                                position = EXCLUDED.position,
                                confidence = EXCLUDED.confidence,
                                company = EXCLUDED.company,
                                domain = EXCLUDED.domain
                        `, [
                            jobId,
                            email.email,
                            email.firstName,
                            email.lastName,
                            email.position,
                            email.confidence,
                            job.company,
                            job.company_domain
                        ]);
                    }
                    console.info(`Inserted ${job.emails.length} email contacts for job ID ${jobId}`);
                }

                insertedCount++;
                console.info(`Inserted job: "${job.title}" at "${job.company}" (ID: ${jobId})`);
            } catch (error) {
                console.error(`Error inserting job "${job.title}" at "${job.company}":`, error);
                // Continue with the next job
            }
        }

        await client.query('COMMIT');
        console.info(`Database transaction committed. Inserted ${insertedCount} jobs.`);

        return insertedCount;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error during database transaction, rolling back:', error);
        return 0;
    } finally {
        client.release();
        console.info('Released database client.');
    }
}

export {
    initDatabase,
    insertJobsIntoDatabase
};

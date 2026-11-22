import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import { createHmac, timingSafeEqual } from 'node:crypto';
import 'dotenv/config'
import Stripe from 'stripe'



const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)



const app = express()
const port = process.env.PORT || 5000;

const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin is not allowed by CORS.'));
    },
    credentials: true,
}));




const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("hireloopdb");
const users = database.collection("user");
const jobs = database.collection("jobs");
const applications = database.collection("applications");
const payments = database.collection("payment");
const sessions = database.collection("session");

function getSessionToken(req) {
    const cookieHeader = req.headers.cookie || '';
    const cookies = new Map(cookieHeader.split(';').map((part) => {
        const separator = part.indexOf('=');
        if (separator < 0) return ['', ''];
        const name = part.slice(0, separator).trim();
        let value = part.slice(separator + 1).trim();
        try { value = decodeURIComponent(value); } catch { /* Keep the raw cookie value. */ }
        return [name, value];
    }));

    const signedCookie = cookies.get('better-auth.session_token')
        || cookies.get('__Secure-better-auth.session_token')
        || cookies.get('__Host-better-auth.session_token');
    if (!signedCookie || !process.env.BETTER_AUTH_SECRET) return null;

    const separator = signedCookie.lastIndexOf('.');
    if (separator <= 0) return null;
    const token = signedCookie.slice(0, separator);
    const providedSignature = Buffer.from(signedCookie.slice(separator + 1), 'base64');
    const expectedSignature = createHmac('sha256', process.env.BETTER_AUTH_SECRET)
        .update(token)
        .digest();
    if (providedSignature.length !== expectedSignature.length || !timingSafeEqual(providedSignature, expectedSignature)) return null;
    return token;
}

async function requireAuth(req, res, next) {
    if (!process.env.BETTER_AUTH_SECRET) {
        return res.status(503).send({ error: 'Backend authentication is not configured.' });
    }

    try {
        const token = getSessionToken(req);
        if (!token) return res.status(401).send({ error: 'Please sign in.' });

        const session = await sessions.findOne({ token, expiresAt: { $gt: new Date() } });
        if (!session || !ObjectId.isValid(session.userId)) return res.status(401).send({ error: 'Your session has expired. Please sign in again.' });

        const user = await users.findOne({ _id: new ObjectId(session.userId) });
        if (!user) return res.status(401).send({ error: 'Account not found.' });
        req.authUser = { ...user, id: String(user._id) };
        return next();
    } catch (error) {
        return next(error);
    }
}

const premiumPlanDays = {
    seeker: { monthly: 30, quarterly: 90, annual: 365 },
    recruiter: { monthly: 30, quarterly: 90, annual: 365 },
};

async function activatePremiumFromCheckout(checkout) {
    const { userId, role, planId } = checkout.metadata || {};
    const durationDays = ['seeker', 'recruiter'].includes(role) ? premiumPlanDays[role]?.[planId] : null;
    if (checkout.mode !== 'payment' || checkout.payment_status !== 'paid' || !ObjectId.isValid(userId || '') || !durationDays) {
        return false;
    }

    const sessionId = checkout.id;
    let payment = await payments.findOne({ sessionId });
    if (!payment) {
        const user = await users.findOne({ _id: new ObjectId(userId) }, { projection: { premiumExpiresAt: 1 } });
        if (!user) return false;
        const paymentIntentId = typeof checkout.payment_intent === 'string'
            ? checkout.payment_intent
            : checkout.payment_intent?.id;
        const paymentIntent = paymentIntentId ? await stripe.paymentIntents.retrieve(paymentIntentId) : null;
        const paymentDate = new Date((paymentIntent?.created ?? checkout.created) * 1000);
        const expiresAt = new Date(paymentDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
        payment = {
            sessionId,
            status: checkout.status,
            payment_status: checkout.payment_status,
            payment_intent: checkout.payment_intent,
            payment_date: paymentDate,
            customer_email: checkout.customer_details?.email || checkout.customer_email,
            userId,
            role,
            planId,
            durationDays,
            expiresAt,
        };
        await payments.insertOne(payment);
    }

    if (new Date(payment.expiresAt) > new Date()) {
        await users.updateOne(
            { _id: new ObjectId(userId) },
            {
                $set: { premium: true, premiumRole: role, premiumPlan: planId },
                $max: { premiumExpiresAt: payment.expiresAt },
            }
        );
    }
    return true;
}

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
        console.error('Stripe webhook signature verification failed:', error.message);
        return res.status(400).send({ error: 'Invalid Stripe webhook signature.' });
    }

    if (event.type === 'checkout.session.completed') {
        const checkout = event.data.object;
        const { userId, role, planId } = checkout.metadata || {};
        if (checkout.mode === 'payment') {
            await activatePremiumFromCheckout(checkout);
        } else if (checkout.mode === 'subscription' && ObjectId.isValid(userId || '') && ['seeker', 'recruiter'].includes(role)) {
            await users.updateOne(
                { _id: new ObjectId(userId) },
                { $set: { premium: true, premiumRole: role, premiumPlan: planId, stripeSubscriptionId: checkout.subscription } }
            );
        }
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const { userId, role, planId } = subscription.metadata || {};
        if (ObjectId.isValid(userId || '') && ['seeker', 'recruiter'].includes(role)) {
            const premium = ['active', 'trialing'].includes(subscription.status);
            await users.updateOne(
                { _id: new ObjectId(userId) },
                { $set: { premium, premiumRole: role, premiumPlan: planId, stripeSubscriptionId: subscription.id } }
            );
        }
    }

    res.send({ received: true });
});

app.use(express.json());



app.get('/users', requireAuth, async (req, res) => {
    if (req.authUser.role?.toLowerCase() !== 'admin') return res.status(403).send({ error: 'Admin access is required.' });
    const cursor = users.find({});
    const results = await cursor.toArray();
    res.send(results);
});


app.get('/users/:id/premimun', requireAuth, async (req, res) => {
    const id = req.params.id
    if (!ObjectId.isValid(id)) return res.status(400).send({ error: 'Invalid user id.' });
    if (req.authUser.id !== id) return res.status(403).send({ error: 'You can only view your own Premium status.' });
    const query = { _id: new ObjectId(id) };
    const result = await users.findOne(query, { projection: { premium: 1, premiumExpiresAt: 1, premiumRole: 1, premiumPlan: 1 } });
    if (!result) return res.status(404).send({ error: 'User not found.' });

    const premium = Boolean(result.premium) && (!result.premiumExpiresAt || new Date(result.premiumExpiresAt) > new Date());
    if (result.premium && !premium) await users.updateOne(query, { $set: { premium: false } });
    res.send({ ...result, premium });
});



app.get('/jobs', async (req, res) => {
    const query = {};
    const normalizedParams = Object.fromEntries(
        Object.entries(req.query).map(([key, value]) => [key.toLowerCase(), value])
    );
    const textFields = [
        'title',
        'companyName',
        'category',
        'jobType',
        'location',
        'deadline',
        'minSalary',
        'maxSalary',
        'frequency',
        'description',
        'requirements',
        'status',
    ];

    for (const field of textFields) {
        const value = normalizedParams[field.toLowerCase()];
        if (typeof value === 'string' && value.trim()) {
            const escapedValue = value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query[field] = { $regex: escapedValue, $options: 'i' };
        }
    }

    const recruiterIdFilter = normalizedParams.recruiterid;
    if (typeof recruiterIdFilter === 'string' && recruiterIdFilter.trim()) {
        query.recruiterId = recruiterIdFilter.trim();
    }

    const isRemote = normalizedParams.isremote?.toLowerCase();
    if (isRemote === 'true' || isRemote === 'false') {
        query.isRemote = isRemote === 'true';
    }


    const result = await jobs.find(query).sort({ createdAt: -1 }).toArray();
    res.send(result);
});



app.get('/jobs/count', requireAuth, async (req, res) => {
    if (req.authUser.role?.toLowerCase() !== 'recruiter') return res.status(403).send({ error: 'Only recruiters can check recruiter job limits.' });
    const count = await jobs.countDocuments({ recruiterId: req.authUser.id });
    res.send({ count });
});

app.get('/jobs/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await jobs.findOne(query);
    res.send(result);
});

app.post('/jobs', requireAuth, async (req, res) => {
    if (req.authUser.role?.toLowerCase() !== 'recruiter') {
        return res.status(403).send({ error: 'Only recruiters can post jobs.' });
    }

    const recruiterId = req.authUser.id;
    const recruiter = req.authUser;
    const count = await jobs.countDocuments({ recruiterId });
    const recruiterPremiumActive = Boolean(recruiter.premium) && (!recruiter.premiumExpiresAt || new Date(recruiter.premiumExpiresAt) > new Date());
    if (!recruiterPremiumActive && count >= 2) {
        return res.status(403).send({ error: 'Free recruiters can post up to 2 jobs. Upgrade to Premium to post more.' });
    }

    const job = { ...req.body, recruiterId, createdAt: new Date() };
    const result = await jobs.insertOne(job);
    res.send(result);
});


app.delete('/jobs/:id', requireAuth, async (req, res) => {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ error: 'Invalid job id.' });
    const query = { _id: new ObjectId(id) };
    const job = await jobs.findOne(query, { projection: { recruiterId: 1 } });
    if (!job) return res.status(404).send({ error: 'Job not found.' });
    if (req.authUser.role?.toLowerCase() !== 'admin' && job.recruiterId !== req.authUser.id) {
        return res.status(403).send({ error: 'You can only delete your own job posts.' });
    }
    const result = await jobs.deleteOne(query);
    res.send(result);
});


app.patch('/jobs/:id', requireAuth, async (req, res) => {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ error: 'Invalid job id.' });
    const query = { _id: new ObjectId(id) };
    const job = await jobs.findOne(query, { projection: { recruiterId: 1 } });
    if (!job) return res.status(404).send({ error: 'Job not found.' });
    if (req.authUser.role?.toLowerCase() !== 'admin' && job.recruiterId !== req.authUser.id) {
        return res.status(403).send({ error: 'You can only edit your own job posts.' });
    }
    const editableFields = Object.fromEntries(
        Object.entries(req.body || {}).filter(([field]) => !['_id', 'recruiterId', 'createdAt'].includes(field))
    );
    const updateDoc = {
        $set: editableFields,
    };
    const result = await jobs.updateOne(query, updateDoc);
    res.send(result);
});


app.post('/applications', requireAuth, async (req, res) => {
    const { jobId, userId, applicantName, applicantEmail, jobTitle, companyName, jobType, location, isRemote } = req.body || {};

    if (!jobId || !ObjectId.isValid(jobId)) {
        return res.status(400).send({ error: "A valid jobId is required." });
    }
    const user = req.authUser;
    if (user.role?.toLowerCase() !== 'seeker') {
        return res.status(403).send({ error: "Only job seekers can apply." });
    }
    const authenticatedUserId = user.id;

    const job = await jobs.findOne({ _id: new ObjectId(jobId) });
    if (!job) return res.status(404).send({ error: 'Job not found.' });

    const existing = await applications.findOne({ jobId, userId: authenticatedUserId });
    if (existing) {
        return res.status(409).send({ error: "You already applied to this job." });
    }

    const premiumActive = Boolean(user.premium)
        && (!user.premiumRole || user.premiumRole === 'seeker')
        && (!user.premiumExpiresAt || new Date(user.premiumExpiresAt) > new Date());
    if (!premiumActive) {
        const applicationCount = await applications.countDocuments({ userId: authenticatedUserId });
        if (applicationCount >= 2) {
            return res.status(403).send({
                error: "The free plan allows up to 2 job applications. Upgrade to Premium to apply to more jobs.",
                code: "JOB_APPLICATION_LIMIT_REACHED",
            });
        }
    }

    const application = {
        jobId,
        userId: authenticatedUserId,
        applicantName: user.name || applicantName || 'Hireloop member',
        applicantEmail: user.email || applicantEmail || '',
        jobTitle: job.title || jobTitle || '',
        companyName: job.companyName || companyName || '',
        jobType: job.jobType || jobType || '',
        location: job.location || location || '',
        isRemote: Boolean(job.isRemote ?? isRemote),
        status: "applied",
        appliedAt: new Date().toISOString(),
        archived: false,
    };

    const result = await applications.insertOne(application);
    res.status(201).send({ ...application, _id: result.insertedId });
});




app.patch('/applications/:id/status', requireAuth, async (req, res) => {
    const applicationId = req.params.id;
    const { status } = req.body || {};
    const allowedStatuses = ['applied', 'review', 'shortlisted', 'interview', 'waiting_list', 'approved', 'rejected', 'offered'];

    if (!ObjectId.isValid(applicationId)) return res.status(400).send({ error: 'Valid application ID is required.' });
    if (req.authUser.role?.toLowerCase() !== 'recruiter') return res.status(403).send({ error: 'Only recruiters can update applicant status.' });
    if (!allowedStatuses.includes(status)) {
        return res.status(400).send({ error: 'Choose a valid application status.' });
    }

    const application = await applications.findOne({ _id: new ObjectId(applicationId) });
    if (!application) return res.status(404).send({ error: 'Application not found.' });
    if (!ObjectId.isValid(application.jobId)) return res.status(404).send({ error: 'Job not found.' });

    const job = await jobs.findOne({ _id: new ObjectId(application.jobId) }, { projection: { recruiterId: 1 } });
    if (!job || job.recruiterId !== req.authUser.id) {
        return res.status(403).send({ error: 'Only the job owner can update applicant status.' });
    }

    await applications.updateOne(
        { _id: new ObjectId(applicationId) },
        { $set: { status, statusUpdatedAt: new Date().toISOString() } }
    );
    res.send({ success: true, status });
});

app.get('/applications/counts', requireAuth, async (req, res) => {
    const jobIds = typeof req.query.jobIds === 'string'
        ? [...new Set(req.query.jobIds.split(',').map((id) => id.trim()).filter(Boolean))]
        : [];
    if (jobIds.length === 0) return res.status(400).send({ error: 'jobIds are required.' });
    if (req.authUser.role?.toLowerCase() !== 'admin' && req.authUser.role?.toLowerCase() !== 'recruiter') {
        return res.status(403).send({ error: 'Only recruiters can view applicant counts.' });
    }

    if (req.authUser.role?.toLowerCase() === 'recruiter') {
        const ownedJobs = await jobs.find(
            { _id: { $in: jobIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) }, recruiterId: req.authUser.id },
            { projection: { _id: 1 } }
        ).toArray();
        const ownedJobIds = new Set(ownedJobs.map((job) => String(job._id)));
        if (jobIds.some((id) => !ownedJobIds.has(id))) {
            return res.status(403).send({ error: 'You can only view applicant counts for your own jobs.' });
        }
    }

    const grouped = await applications.aggregate([
        { $match: { jobId: { $in: jobIds } } },
        { $group: { _id: '$jobId', count: { $sum: 1 } } },
    ]).toArray();
    const counts = Object.fromEntries(jobIds.map((id) => [id, 0]));
    for (const item of grouped) counts[item._id] = item.count;
    res.send({ counts });
});

app.get('/applications', requireAuth, async (req, res) => {
    const query = {};
    if (req.authUser.role?.toLowerCase() === 'seeker') {
        query.userId = req.authUser.id;
    } else if (req.authUser.role?.toLowerCase() === 'recruiter' && typeof req.query.jobId === 'string') {
        if (!ObjectId.isValid(req.query.jobId)) return res.status(400).send({ error: 'Invalid jobId.' });
        const job = await jobs.findOne({ _id: new ObjectId(req.query.jobId) }, { projection: { recruiterId: 1 } });
        if (!job || job.recruiterId !== req.authUser.id) return res.status(403).send({ error: 'You can only view applicants for your own jobs.' });
        query.jobId = req.query.jobId;
    } else if (req.authUser.role?.toLowerCase() !== 'admin') {
        return res.status(403).send({ error: 'You are not allowed to view these applications.' });
    }
    if (req.authUser.role?.toLowerCase() === 'admin' && typeof req.query.jobId === 'string') query.jobId = req.query.jobId;
    const result = await applications.find(query).toArray();
    res.send(result);
});

app.get('/applications/count', requireAuth, async (req, res) => {
    if (req.authUser.role?.toLowerCase() !== 'seeker') return res.status(403).send({ error: 'Only seekers can view their application count.' });
    const result = await applications.countDocuments({ userId: req.authUser.id });
    res.send({ count: result });
});

// payment api 

app.post('/payment/checkout-verify', async (req, res) => {
    const { sessionId } = req.body
    if (!sessionId) return res.status(400).send({ success: false, message: 'sessionId is required.' });

    const checkout = await stripe.checkout.sessions.retrieve(sessionId);
    if (checkout.status === 'complete' && checkout.mode === 'payment' && checkout.payment_status === 'paid') {
        const activated = await activatePremiumFromCheckout(checkout);
        if (activated) return res.send({ success: true });
    }

    res.status(400).send({ success: false, message: 'Payment verification failed.' });
});


app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})  

import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'
import Stripe from 'stripe'



const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)



const app = express()
const port = process.env.PORT || 5000;

app.use(cors());




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



app.get('/users', async (req, res) => {
    const cursor = users.find({});
    const results = await cursor.toArray();
    res.send(results);
});


app.get('/users/:id/premimun', async (req, res) => {
    const id = req.params.id
    if (!ObjectId.isValid(id)) return res.status(400).send({ error: 'Invalid user id.' });
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



app.get('/jobs/count', async (req, res) => {
    const recruiterId = req.query.recruiterId;
    if (typeof recruiterId !== 'string' || !recruiterId.trim()) {
        return res.status(400).send({ error: 'recruiterId is required.' });
    }

    const count = await jobs.countDocuments({ recruiterId: recruiterId.trim() });
    res.send({ count });
});

app.get('/jobs/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await jobs.findOne(query);
    res.send(result);
});

app.post('/jobs', async (req, res) => {
    const recruiterId = req.body?.recruiterId;
    if (typeof recruiterId !== 'string' || !recruiterId.trim()) {
        return res.status(400).send({ error: 'recruiterId is required.' });
    }
    if (!ObjectId.isValid(recruiterId)) {
        return res.status(400).send({ error: 'Invalid recruiterId.' });
    }

    const recruiter = await users.findOne(
        { _id: new ObjectId(recruiterId) },
        { projection: { role: 1, premium: 1, premiumExpiresAt: 1 } }
    );
    if (!recruiter || recruiter.role?.toLowerCase() !== 'recruiter') {
        return res.status(403).send({ error: 'Only recruiters can post jobs.' });
    }

    const count = await jobs.countDocuments({ recruiterId });
    const recruiterPremiumActive = Boolean(recruiter.premium) && (!recruiter.premiumExpiresAt || new Date(recruiter.premiumExpiresAt) > new Date());
    if (!recruiterPremiumActive && count >= 2) {
        return res.status(403).send({ error: 'Free recruiters can post up to 2 jobs. Upgrade to Premium to post more.' });
    }

    const job = { ...req.body, recruiterId, createdAt: new Date() };
    const result = await jobs.insertOne(job);
    res.send(result);
});


app.delete('/jobs/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await jobs.deleteOne(query);
    res.send(result);
});


app.patch('/jobs/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const updateDoc = {
        $set: req.body,
    };
    const result = await jobs.updateOne(query, updateDoc);
    res.send(result);
});


app.post('/applications', async (req, res) => {
    const { jobId, userId, applicantName, applicantEmail, jobTitle, companyName, jobType, location, isRemote } = req.body || {};

    if (!jobId || !userId) {
        return res.status(400).send({ error: "jobId and userId are required." });
    }
    if (!ObjectId.isValid(userId)) {
        return res.status(400).send({ error: "Invalid userId." });
    }

    const user = await users.findOne(
        { _id: new ObjectId(userId) },
        { projection: { role: 1, premium: 1, premiumRole: 1, premiumExpiresAt: 1 } }
    );
    if (!user || user.role?.toLowerCase() !== 'seeker') {
        return res.status(403).send({ error: "Only job seekers can apply." });
    }

    const existing = await applications.findOne({ jobId, userId });
    if (existing) {
        return res.status(409).send({ error: "You already applied to this job." });
    }

    const premiumActive = Boolean(user.premium)
        && (!user.premiumRole || user.premiumRole === 'seeker')
        && (!user.premiumExpiresAt || new Date(user.premiumExpiresAt) > new Date());
    if (!premiumActive) {
        const applicationCount = await applications.countDocuments({ userId });
        if (applicationCount >= 2) {
            return res.status(403).send({
                error: "The free plan allows up to 2 job applications. Upgrade to Premium to apply to more jobs.",
                code: "JOB_APPLICATION_LIMIT_REACHED",
            });
        }
    }

    const application = {
        jobId,
        userId,
        applicantName,
        applicantEmail,
        jobTitle,
        companyName,
        jobType,
        location,
        isRemote: Boolean(isRemote),
        status: "applied",
        appliedAt: new Date().toISOString(),
        archived: false,
    };

    const result = await applications.insertOne(application);
    res.status(201).send({ ...application, _id: result.insertedId });
});




app.patch('/applications/:id/status', async (req, res) => {
    const applicationId = req.params.id;
    const { status, recruiterId } = req.body || {};
    const allowedStatuses = ['applied', 'review', 'shortlisted', 'interview', 'waiting_list', 'approved', 'rejected', 'offered'];

    if (!ObjectId.isValid(applicationId) || !ObjectId.isValid(recruiterId || '')) {
        return res.status(400).send({ error: 'Valid application and recruiter IDs are required.' });
    }
    if (!allowedStatuses.includes(status)) {
        return res.status(400).send({ error: 'Choose a valid application status.' });
    }

    const application = await applications.findOne({ _id: new ObjectId(applicationId) });
    if (!application) return res.status(404).send({ error: 'Application not found.' });
    if (!ObjectId.isValid(application.jobId)) return res.status(404).send({ error: 'Job not found.' });

    const [job, recruiter] = await Promise.all([
        jobs.findOne({ _id: new ObjectId(application.jobId) }, { projection: { recruiterId: 1 } }),
        users.findOne({ _id: new ObjectId(recruiterId) }, { projection: { role: 1 } }),
    ]);
    if (!job || job.recruiterId !== recruiterId || recruiter?.role?.toLowerCase() !== 'recruiter') {
        return res.status(403).send({ error: 'Only the job owner can update applicant status.' });
    }

    await applications.updateOne(
        { _id: new ObjectId(applicationId) },
        { $set: { status, statusUpdatedAt: new Date().toISOString() } }
    );
    res.send({ success: true, status });
});

app.get('/applications/counts', async (req, res) => {
    const jobIds = typeof req.query.jobIds === 'string'
        ? [...new Set(req.query.jobIds.split(',').map((id) => id.trim()).filter(Boolean))]
        : [];
    if (jobIds.length === 0) return res.status(400).send({ error: 'jobIds are required.' });

    const grouped = await applications.aggregate([
        { $match: { jobId: { $in: jobIds } } },
        { $group: { _id: '$jobId', count: { $sum: 1 } } },
    ]).toArray();
    const counts = Object.fromEntries(jobIds.map((id) => [id, 0]));
    for (const item of grouped) counts[item._id] = item.count;
    res.send({ counts });
});

app.get('/applications', async (req, res) => {
    const query = {};
    const applicantId = req.query.applicantId || req.query.userId;
    if (applicantId) {
        query.userId = applicantId;
    }
    if (req.query.jobId) query.jobId = req.query.jobId;
    const result = await applications.find(query).toArray();
    res.send(result);
});

app.get('/applications/count', async (req, res) => {
    const query = {};
    const applicantId = req.query.applicantId || req.query.userId;
    if (applicantId) {
        query.userId = applicantId;
    }
    if (req.query.jobId) query.jobId = req.query.jobId;
    const result = await applications.countDocuments(query)
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

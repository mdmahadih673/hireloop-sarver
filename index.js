import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'


const app = express()
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());




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


app.get('/users', async (req, res) => {
    const cursor = users.find({});
    const results = await cursor.toArray();
    res.send(results);
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

    const isRemote = normalizedParams.isremote?.toLowerCase();
    if (isRemote === 'true' || isRemote === 'false') {
        query.isRemote = isRemote === 'true';
    }


    const result = await jobs.find(query).sort({ createdAt: -1 }).toArray();
    res.send(result);
});


app.get('/jobs/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await jobs.findOne(query);
    res.send(result);
});

app.post('/jobs', async (req, res) => {
    const job = { ...req.body, createdAt: new Date() };
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

    const existing = await applications.findOne({ jobId, userId });
    if (existing) {
        return res.status(409).send({ error: "You already applied to this job." });
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




app.get('/applications', async (req, res) => {
    const query = {};
    if (req.query.applicantId) {
        query.userId = req.query.applicantId;
    }
    const result = await applications.find(query).toArray();
    res.send(result);
});

app.get('/applications/count', async (req, res) => {
    const query = {};
    if (req.query.applicantId) {
        query.userId = req.query.applicantId;
    }
    const result = await applications.countDocuments(query)
    res.send({count: result});
});


app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})  

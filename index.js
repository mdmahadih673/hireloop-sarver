import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
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


app.get('/users', async (req, res) => {
    const cursor = users.find({});
    const results = await cursor.toArray();
    res.send(results);
});

app.get('/jobs', async (req, res) => {
    const result = await jobs.find({}).sort({ createdAt: -1 }).toArray();
    res.send(result);
});

app.post('/jobs', async (req, res) => {
    const job = { ...req.body, createdAt: new Date() };
    const result = await jobs.insertOne(job);
    res.send(result);
});

app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})  

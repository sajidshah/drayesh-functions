const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const rateLimit = require("express-rate-limit");
const cors = require("cors")({ origin: true });

const rateLimit = require("express-rate-limit");

const axios = require("axios");

// Initialize Firebase Admin SDK
// admin.initializeApp();
if (admin.apps.length === 0) {
    admin.initializeApp();
}

// Create an Express app
const app = express();
app.use(cors({ origin: true })); // Allow all origins (change to specific domains for better security)
app.use(express.json()); // Parse JSON request bodies


// Apply rate limiting
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // Limit each user to 5 requests per minute
    message: { error: "Too many requests, please try again later." },
    keyGenerator: (req) => req.headers.authorization || req.ip, // Use Firebase ID token if available, else fallback to IP
});

app.use(limiter);
app.post("/submitAnswer", async (req, res) => {

    // Get the Firebase ID Token from the request headers
    const idToken = req.headers.authorization?.split("Bearer ")[1];

    if (!idToken) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // // Verify the token
        // const decodedToken = await admin.auth().verifyIdToken(idToken);
        // const uid = decodedToken.uid;

        // Verify the token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Perform operations based on the UID
        // Example: Fetch user data from Firestore
        const userDoc = await admin.firestore().collection("users").doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        console.log('User Requesting: ', uid);
        // const userData = userDoc.data();


        // Extract `question_doc_id` and `answer` from request body
        const { question_doc_id, answer } = req.body;

        if (!question_doc_id || !answer) {
            return res.status(400).json({ error: "Missing required parameters", question_doc_id, answer });
        }

        // Reference the quiz question document
        const questionRef = admin.firestore().collection("quiz_questions").doc(question_doc_id);
        const questionSnap = await questionRef.get();

        if (!questionSnap.exists) {
            return res.status(404).json({ error: "Question not found" });
        }

        const questionData = questionSnap.data();

        // Check if user has already answered
        const participants = questionData.participants || [];

        if (participants.includes(uid)) {
            return res.status(200).json({
                success: false,
                message: "You have already submitted an answer for this question."
            });
        }

        // Add user to participants list
        participants.push(uid);
        await questionRef.update({ participants });

        // Check if the answer is correct
        const correctAnswer = questionData.answer; // Assuming the correct answer is stored in Firestore
        let pointsAwarded = 0;
        let isCorrect = false;

        if (answer === correctAnswer) {
            isCorrect = true;
            pointsAwarded = questionData.points || 0;

            // Increment correct_count for the question
            const correctCount = (questionData.correct_count || 0) + 1;
            await questionRef.update({ correct_count: correctCount });

            // Update user's points
            const userRef = admin.firestore().collection("users").doc(uid);
            await admin.firestore().runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                if (!userDoc.exists) {
                    throw new Error("User not found");
                }
                const userData = userDoc.data();
                const updatedPoints = (userData.points || 0) + pointsAwarded;
                transaction.update(userRef, { points: updatedPoints });
            });
        }

        return res.status(200).json({
            success: true,
            message: isCorrect ? "Answer submitted successfully" : "Answer submitted",
            correct: isCorrect,
            points_awarded: pointsAwarded
        });

    } catch (error) {
        console.error("Error processing answer:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// Export Firebase function with Express
exports.api = functions.https.onRequest(app);
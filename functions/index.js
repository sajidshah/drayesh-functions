const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });
const axios = require("axios");

let HYPERPAY_BASE_URL
let ACCESS_TOKEN
let ENTITY_ID

const test = false; //is false.. ... 
if(test){
  HYPERPAY_BASE_URL = "https://test.oppwa.com/v1"; // ✅ Change to production URL when ready
  ACCESS_TOKEN = "OGFjN2E0Yzc5NTE1ZWQ5YTAxOTUxOTc1MTE0YTA2MDZ8bVp0Q0ErNmRVZEw9Q05HbmMyVXU="; // test
  ENTITY_ID = "8ac7a4c79515ed9a01951975847a060a"; // test
}else{
  HYPERPAY_BASE_URL = "https://eu-prod.oppwa.com/v1"; // ✅ Change to production URL when ready
  ACCESS_TOKEN = "OGFjZGE0Yzc5NTM4MDhhMDAxOTU0NmFiMWI1OTM0MmZ8YzZoYzk1bVBHS1c6VDRtVVNSZTo="; // live
  ENTITY_ID = "8acda4c7953808a0019546ab9cf33439"; // live
}

// Initialize Firebase Admin SDK
// admin.initializeApp();
if (admin.apps.length === 0) {
    admin.initializeApp();
}


exports.submitAnswer = functions.https.onRequest(async (req, res) => {
    console.log("submitAnswer function triggered");

    const idToken = req.headers.authorization?.split("Bearer ")[1];

    if (!idToken) {
        console.warn("Unauthorized access attempt", { headers: req.headers });
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        console.log("Verifying token...");
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;
        console.log("User authenticated:", uid);

        const { question_doc_id, answer } = req.body;
        if (!question_doc_id || !answer) {
            return res.status(400).json({ error: "Missing required parameters" });
        }

        const userRef = admin.firestore().collection("users").doc(uid);
        const questionRef = admin.firestore().collection("quiz_questions").doc(question_doc_id);

        console.log("Starting Firestore transaction...");
        const result = await admin.firestore().runTransaction(async (transaction) => {
            // ✅ Step 1: Read user document FIRST
            const userSnap = await transaction.get(userRef);
            if (!userSnap.exists) {
                return { error: "User not found", status: 404 };
            }
            const userData = userSnap.data();
            const lastSubmissionTime = userData.last_submission_time || 0;

            // ✅ Step 2: Read question document SECOND
            const questionSnap = await transaction.get(questionRef);
            if (!questionSnap.exists) {
                return { error: "Question not found", status: 404 };
            }
            let questionData = questionSnap.data();
            let participants = questionData.participants || [];

            // ✅ Step 3: Check time limit (AFTER all reads are completed)
            const currentTime = Date.now();
            if (currentTime - lastSubmissionTime < 10 * 1000) {
                // return { success: false, message: "You are submitting too fast. Please wait 15 seconds." };
                return {
                    statusCode: 429, 
                    success: false, 
                    message: "Request limit exceeded."
                };
            }

            // ✅ Step 4: Now we can update last_submission_time
            transaction.update(userRef, { last_submission_time: currentTime });

            // ✅ Step 5: Check if user already submitted the answer
            if (participants.includes(uid)) {
                return { success: false, message: "You have already submitted an answer for this question." };
            }

            console.log("User has not answered yet, proceeding...");

            // ✅ Step 6: Add user to participants and update Firestore
            participants.push(uid);
            transaction.update(questionRef, { participants });

            const correctAnswer = questionData.answer;
            let pointsAwarded = 0;
            let isCorrect = false;

            if (answer === correctAnswer) {
                isCorrect = true;
                pointsAwarded = questionData.points || 0;
                const correctCount = (questionData.correct_count || 0) + 1;

                // Update question document (correct_count)
                transaction.update(questionRef, { correct_count: correctCount });

                // Update user points
                const updatedPoints = (userData.points || 0) + pointsAwarded;
                transaction.update(userRef, { points: updatedPoints });
            }

            return {
                success: true,
                message: isCorrect ? "Answer submitted successfully" : "Answer submitted",
                correct: isCorrect,
                points_awarded: pointsAwarded
            };
        });

        console.log("Transaction completed", result);
        return res.status(result.status || 200).json(result);

    } catch (error) {
        console.error("Error processing answer:", {
            message: error.message,
            stack: error.stack,
            request: req.body
        });
        return res.status(500).json({ error: "Internal server error" });
    }
});



// Define VAT (15%)
const VAT_RATE = 0.15;
// const FieldValue = admin.firestore.FieldValue;

exports.createCheckout = functions.https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed" });
        }

        // Get Firebase ID Token from headers
        const idToken = req.headers.authorization?.split("Bearer ")[1];

        if (!idToken) {
            return res.status(401).json({ error: "Unauthorized: No token provided" });
        }

        try {
            // Verify Firebase token and extract user ID
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            const uid = decodedToken.uid;

            // Fetch user data from Firestore
            const userRef = admin.firestore().collection("users").doc(uid);
            const userDoc = await userRef.get();

            if (!userDoc.exists) {
                return res.status(404).json({ error: "User not found in Firestore" });
            }

            const userData = userDoc.data();

            // Extract product_id from request body
            const { product_id, currency = "SAR" } = req.body;

            if (!product_id) {
                return res.status(400).json({ error: "Missing required field: product_id" });
            }

            // Fetch ticket details from Firestore
            const ticketRef = admin.firestore().collection("tickets").doc(product_id);
            const ticketDoc = await ticketRef.get();

            if (!ticketDoc.exists) {
                return res.status(404).json({ error: "Ticket not found" });
            }

            const ticketData = ticketDoc.data();
            const discountRate = ticketData.discount || 0; // e.g., 0.2 for 20% discount
            const price = ticketData.price || 0;
            const points = ticketData.points || 0;
            const status = "processing";

            // Calculate grand total
            const discountedAmount = price * (1 - discountRate/100); // Apply discount
            const tax = discountedAmount * VAT_RATE; // 15% VAT
            const grandTotal = (discountedAmount + tax).toFixed(2); // Ensure 2 decimal places

            // Generate a new order ID
            const newOrderRef = admin.firestore().collection("init_order").doc();
            const orderId = newOrderRef.id; // Newly generated document ID

            // const { FieldValue } = admin.firestore;

            // Prepare order data
            const orderData = {
                currency,
                discount: discountRate,
                doc_id: orderId,
                grand_total: parseFloat(grandTotal),
                initial_amount: parseFloat(price),
                points,
                status,
                tax: VAT_RATE, //parseFloat(tax.toFixed(2)),
                ticket_id: product_id,
                uid,
                updated_at: Date.now()
            };

            // Save order to Firestore
            await newOrderRef.set(orderData);

            // Prepare HyperPay request data
            const hyperpayData = {
                entityId: ENTITY_ID,
                amount: grandTotal,
                currency,
                paymentType: "DB",
                integrity: true,
                merchantTransactionId: orderId, // Use newly created order ID
                "customer.email": userData.email || decodedToken.email,
                // "billing.street1": userData.city || "123 Street",
                "billing.city": userData.city || "Riyadh",
                // "billing.state": userData.city || "Riyadh",
                "billing.country": "SA",
                // "billing.postcode": userData.postcode || "12345",
                "customer.givenName": userData.name || "",
                // "customer.surname": "", // Empty surname if it works
            };

            // Send request to HyperPay
            const checkoutResponse = await axios.post(
                `${HYPERPAY_BASE_URL}/checkouts`,
                new URLSearchParams(hyperpayData),
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                }
            );

            console.log("🔗 HyperPay Checkout Response:", checkoutResponse.data);

            // Update order with HyperPay response
            await newOrderRef.update({
                integrity: checkoutResponse.data.result?.code || "",
                checkout_id: checkoutResponse.data.id || "",
            });

            // Return HyperPay response to user
            return res.json({
                success: true,
                checkoutId: checkoutResponse.data.id,
                response: checkoutResponse.data,
                merchantTransactionId: orderId,
            });
        } catch (error) {
            console.error("❌ Error in createCheckout:", error.response?.data || error.message);
            return res.status(500).json({
                error: "Failed to create checkout",
                details: error.response?.data || error.message,
            });
        }
    });
});
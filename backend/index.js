const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const pgp = require("pg-promise")();
const dotenv = require("dotenv");
const mqtt = require("mqtt");
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const db = pgp({ connectionString: process.env.DATABASE_URL });
const redirectURL = process.env.REDIRECT_URL;
const MQTT_BROKER = process.env.MQTT_BROKER;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

// ---------------- CONNECTIONS ----------------

// Ensure the database connection is established
db.connect()
    .then(() => {
        console.log("✅ Connected to the database");

        // Add database migration for cantidad column
        return db.none(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'reparto' AND column_name = 'cantidad'
                ) THEN
                    ALTER TABLE reparto ADD COLUMN cantidad INTEGER DEFAULT 12;
                    RAISE NOTICE 'Added cantidad column to reparto table';
                END IF;
            END $$;
        `)
            .then(() => {
                console.log("✅ Database schema is up-to-date");
            })
            .catch(error => {
                console.error("❌ Error updating database schema:", error);
            });
    })
    .catch((error) => {
        console.error("❌ Error connecting to the database:", error);
        process.exit(1);
    });

// MQTT client setup
const mqttClient = mqtt.connect(MQTT_BROKER, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD
});
let mqttConnected = false;

// MQTT connection event handlers
mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT broker:', MQTT_BROKER);
    mqttConnected = true;
    // Subscribe to all relevant topics
    mqttClient.subscribe([
        'PR2A1/avisos/parada_emergencia',
        'PR2A1/status/conveyor_1',
        'PR2A1/status/conveyor_2',
        'PR2A1/status/infrarrojos_1',
        'PR2A1/status/infrarrojos_2',
        'PR2A1/status/agv',
        'PR2A1/avisos/QR'
    ], (err) => {
        if (err) {
            console.error('❌ Error subscribing to topics:', err);
        } else {
            console.log('✅ Subscribed to all status topics');
        }
    });
});

mqttClient.on('error', (error) => {
    console.error('❌ MQTT connection error:', error);
    mqttConnected = false;
});

mqttClient.on('offline', () => {
    console.log('⚠️ MQTT client offline');
    mqttConnected = false;
});

mqttClient.on('reconnect', () => {
    console.log('🔄 Attempting to reconnect to MQTT broker');
});

// ---------------- ROUTES ----------------

// Global system state
const systemState = {
    emergencyStop: false,
    conveyor1Status: 'Parado',
    conveyor2Status: 'Parado',
    infrared1Status: 0,
    infrared2Status: 0,
    agvStatus: {
        ubicacion: 0,
        estado: 'drop'  // Initial state: no pallet carried
    },
    pendingBoxes: 0,
    currentOperation: null
};

// MQTT message handler
mqttClient.on('message', (topic, message) => {
    const messageStr = message.toString();
    console.log(`📨 Received MQTT message on ${topic}: ${messageStr}`);

    // Handle different topics
    switch (topic) {
        case 'PR2A1/avisos/parada_emergencia':
            // Any message to this topic triggers emergency stop
            systemState.emergencyStop = true;
            handleEmergencyStop();
            break;

        case 'PR2A1/status/conveyor_1':
            systemState.conveyor1Status = messageStr;
            break;

        case 'PR2A1/status/conveyor_2':
            systemState.conveyor2Status = messageStr;
            break;

        case 'PR2A1/status/infrarrojos_1':
            systemState.infrared1Status = parseInt(messageStr);
            handleInfrared1StatusChange(parseInt(messageStr));
            break;

        case 'PR2A1/status/infrarrojos_2':
            systemState.infrared2Status = parseInt(messageStr);
            handleInfrared2StatusChange(parseInt(messageStr));
            break;

        case 'PR2A1/status/agv':
            try {
                const agvStatus = JSON.parse(messageStr);
                console.log('AGV Status:', agvStatus);
                systemState.agvStatus.ubicacion = agvStatus.ubicacion;
                systemState.agvStatus.estado = agvStatus.estado;

                // If we have a current operation and AGV has reached designated position
                if (systemState.currentOperation &&
                    systemState.currentOperation.agvTargetPosition === agvStatus.ubicacion) {
                    handleAgvReachedPosition(agvStatus);
                }
            } catch (error) {
                console.error('❌ Error parsing AGV status:', error);
            }
            break;
        case 'PR2A1/avisos/QR':
            try {
                const qrData = JSON.parse(messageStr);
                console.log('QR Code Data:', qrData);
                handleQrCodeEntry(qrData)
                    .catch(error => {
                        console.error('❌ Error handling QR code:', error);
                    });
            } catch (error) {
                console.error('❌ Error parsing QR code data:', error);
            }
            break;
    }
});

// Emergency stop handler - stops all operations
function handleEmergencyStop() {
    console.log('🚨 EMERGENCY STOP ACTIVATED');

    // Get almacen from current operation if available
    const almacen = systemState.currentOperation?.almacen || "Vera";

    // Only send MQTT messages for Vera campus
    if (almacen === "Vera") {
        // Stop conveyor 1
        publishMqttMessage('PR2A1/acciones/conveyor_1', JSON.stringify({
            accion: "parada"
        }));

        // Stop conveyor 2
        publishMqttMessage('PR2A1/acciones/conveyor_2', JSON.stringify({
            accion: "parada"
        }));

        // Stop paletizaje
        publishMqttMessage('PR2A1/acciones/paletizaje', JSON.stringify({
            accion: "parada",
            modo: systemState.currentOperation?.mode || "paletizar"
        }));

        // Stop cobot
        publishMqttMessage('PR2A1/cobot/recogida', JSON.stringify({
            accion: "parada"
        }));
    } else {
        // For non-Vera campuses, just log the simulation
        console.log(`🔄 [Simulation ${almacen}] Would send MQTT messages to stop all equipment`);
    }

    // Reset current operation
    systemState.currentOperation = null;
    systemState.pendingBoxes = 0;
}

// Fix the QR code entrada handler
app.post("/api/qr-entrada", bodyParser.json(), async (req, res) => {
    console.log("Received QR code data:", req.body);

    try {
        // Extract data from QR code 
        let { id } = req.body;

        if (!id) {
            console.error("Missing id in QR code");
            return res.status(400).json({ error: "Missing id in QR code" });
        }

        // Check if product exists and get warehouse information
        const product = await db.oneOrNone('SELECT lectura, almacen, cantidad FROM reparto WHERE id = $1', [id]);
        if (!product) {
            console.error(`Product with code ${id} not found`);
            return res.status(404).json({ error: `Product with code ${id} not found` });
        }

        const almacen = product.almacen;
        const cantidad = parseInt(product.cantidad || 12); // Parse to integer

        // Find available location in warehouse specific to this almacen
        const usedLocations = await db.any(
            "SELECT location FROM reparto WHERE location IS NOT NULL AND almacen = $1",
            [almacen]
        );

        console.log(`Used locations in warehouse ${almacen}:`, usedLocations);

        // Convert to a set of numbers for easy lookup
        const usedLocationSet = new Set(
            usedLocations.map((row) => parseInt(row.location))
        );

        console.log(`Used locations for ${almacen}:`, usedLocationSet);

        // Find first available location between 1-5 for this almacen
        let availablePosition = null;
        for (let i = 1; i <= 5; i++) {
            if (!usedLocationSet.has(i)) {
                availablePosition = i;
                break;
            }
        }

        if (availablePosition === null) {
            console.error(`No available positions in warehouse ${almacen}`);
            return res.status(400).json({ error: `No available positions in warehouse ${almacen}` });
        }

        // Store the entry operation in the system state
        systemState.currentOperation = {
            type: 'entrada',
            position: availablePosition,
            cantidad: cantidad,
            productId: id,
            almacen: almacen,
            phase: 'picking_from_storage',
            agvTargetPosition: availablePosition
        };

        // Set pending boxes
        systemState.pendingBoxes = cantidad;

        // Only send MQTT messages for Vera campus
        if (almacen === "Vera") {
            // Publish directive with the quantity
            publishMqttMessage('PR2A1/acciones/directriz', `{"accion": "entrada", "cantidad": "${cantidad}", "posicion": "${availablePosition}"}`
            );
            console.log(`✅ Physical automation started for Vera warehouse at position ${availablePosition} with ${cantidad} boxes`);
        } else {
            // For non-Vera campuses, just log the simulation
            console.log(`🔄 [Simulation ${almacen}] Would send MQTT messages to start picking pallet at position ${availablePosition} with ${cantidad} boxes`);
        }

        // Modify the database to set the location for the product, as well as the timestamp_recepcion
        await db.none(
            "UPDATE reparto SET location = $1, timestamp_recepcion = NOW() WHERE id = $2",
            [availablePosition, id]
        );
        console.log(`✅ Product ${id} assigned to location ${availablePosition} in ${almacen} warehouse`);

        return res.status(200).json({
            success: true,
            location: availablePosition,
            cantidad: cantidad,
            message: `Product assigned to location ${availablePosition}`
        });

    } catch (error) {
        console.error('Error processing QR code entry:', error);
        return res.status(500).json({ error: "Error processing QR code entry" });
    }
});

// Fix the handleQrCodeEntry function to ensure numeric values
async function handleQrCodeEntry(qrData) {
    console.log("Received QR code data:", qrData);

    try {
        let parsedData;

        // Handle case when QR data comes with 'QR Code' wrapper
        if (qrData['QR Code']) {
            try {
                parsedData = JSON.parse(qrData['QR Code']);
                console.log("Parsed QR code data:", parsedData);
            } catch (e) {
                console.error("Failed to parse 'QR Code' content:", e);
                return;
            }
        } else {
            // Use as-is if it's already in the expected format
            parsedData = qrData;
        }

        // Extract data from QR code 
        const { id, cantidad: qrCantidad, lectura } = parsedData;
        const cantidad = parseInt(qrCantidad || 12); // Parse to integer

        if (!id && !lectura) {
            console.error("Missing id or lectura in QR code");
            return;
        }

        // Determine how to look up the product based on available data
        let product;
        if (id) {
            product = await db.oneOrNone('SELECT lectura, almacen FROM reparto WHERE id = $1', [id]);
        } else {
            product = await db.oneOrNone('SELECT lectura, almacen FROM reparto WHERE lectura = $1', [lectura]);
        }

        if (!product) {
            console.error(`Product not found with ${id ? 'ID ' + id : 'lectura ' + lectura}`);
            return;
        }

        const almacen = product.almacen;

        // Find available location in warehouse specific to this almacen
        const usedLocations = await db.any(
            "SELECT location FROM reparto WHERE location IS NOT NULL AND almacen = $1",
            [almacen]
        );

        console.log(`Used locations in warehouse ${almacen}:`, usedLocations);

        // Convert to a set of numbers for easy lookup
        const usedLocationSet = new Set(
            usedLocations.map((row) => parseInt(row.location))
        );

        console.log(`Used locations for ${almacen}:`, usedLocationSet);

        // Find first available location between 1-5 for this almacen
        let availablePosition = null;
        for (let i = 1; i <= 5; i++) {
            if (!usedLocationSet.has(i)) {
                availablePosition = i;
                break;
            }
        }

        if (availablePosition === null) {
            console.error(`No available positions in warehouse ${almacen}`);
            return;
        }

        // Store the entry operation in the system state
        systemState.currentOperation = {
            type: 'entrada',
            position: availablePosition,
            cantidad: cantidad,
            productId: id || lectura,
            almacen: almacen,
            phase: 'picking_from_storage',
            agvTargetPosition: availablePosition
        };

        // Set pending boxes
        systemState.pendingBoxes = cantidad;

        // Only send MQTT messages for Vera campus
        if (almacen === "Vera") {
            // Publish directive with the quantity
            publishMqttMessage('PR2A1/acciones/directriz', `{"accion": "entrada", "cantidad": "${cantidad}", "posicion": "${availablePosition}"}`);

            console.log(`✅ Physical automation started for Vera warehouse at position ${availablePosition} with ${cantidad} boxes`);
        } else {
            // For non-Vera campuses, just log the simulation
            console.log(`🔄 [Simulation ${almacen}] Would send MQTT messages to start picking pallet at position ${availablePosition} with ${cantidad} boxes`);
        }

        // Modify the database to set the location for the product, as well as the timestamp_recepcion
        const fieldToUse = id ? 'id' : 'lectura';
        const valueToUse = id || lectura;

        await db.none(
            `UPDATE reparto SET location = $1, timestamp_recepcion = NOW() WHERE ${fieldToUse} = $2`,
            [availablePosition, valueToUse]
        );
        console.log(`✅ Product ${valueToUse} assigned to location ${availablePosition} in ${almacen} warehouse`);

    } catch (error) {
        console.error('Error processing QR code entry:', error);
    }
}

// Function to publish MQTT messages with proper number conversion
function publishMqttMessage(topic, message, almacen) {
    // If almacen is specified and not Vera, simulate instead of sending real messages
    if (almacen && almacen !== "Vera") {
        console.log(`🔄 [Simulation ${almacen}] Would publish to ${topic}:`,
            typeof message === 'object' ? JSON.stringify(message) : message);
        return true;
    }

    if (!mqttConnected) {
        console.error(`❌ Cannot publish to ${topic}: MQTT client not connected`);
        return false;
    }

    try {
        const messageStr = message;
        mqttClient.publish(topic, messageStr, { qos: 1 }, (err) => {
            if (err) {
                console.error(`❌ Error publishing to ${topic}:`, err);
                return false;
            }
            console.log(`📤 Published to ${topic}:`, messageStr);
        });
        return true;
    } catch (error) {
        console.error(`❌ Error preparing message for ${topic}:`, error);
        return false;
    }
}

// Update salida-particulares to handle almacen-specific behavior
app.post("/api/salida-particulares", bodyParser.json(), async (req, res) => {
    console.log("Received salida particulares request:", req.body);

    // Verify authorization
    if (!verifyPwd(req, res)) {
        return;
    }

    try {
        const { id } = req.body;

        // Get reparto record to find position, cantidad and product details
        const reparto = await db.oneOrNone(
            "SELECT id, almacen, lectura, location, cantidad FROM reparto WHERE id = $1", // Include cantidad
            [id]
        );

        if (!reparto) {
            return res.status(404).json({ error: "Reparto record not found" });
        }

        if (!reparto.location) {
            return res.status(400).json({ error: "This product is not stored in a warehouse location" });
        }

        const almacen = reparto.almacen;

        // Use the stored cantidad from database instead of hardcoded value
        const boxCount = reparto.cantidad || 10; // Fallback to 10 if cantidad is null

        // Store the exit operation in the system state
        systemState.currentOperation = {
            type: 'salida_particulares',
            position: reparto.location,
            productId: reparto.lectura,
            cantidad: boxCount, // Add cantidad to the operation state
            almacen: almacen,
            phase: 'picking_from_storage',
            agvTargetPosition: reparto.location
        };

        // Set pending boxes
        systemState.pendingBoxes = boxCount;

        // Only send MQTT messages for Vera campus
        if (almacen === "Vera") {
            // Publish directive with cantidad
            publishMqttMessage('PR2A1/acciones/directriz', `{"accion": "salida_particulares", "posicion": "${reparto.location}", "cantidad": "${boxCount}"}`);
            console.log(`✅ Physical automation started for Vera warehouse at position ${reparto.location} with ${boxCount} boxes`);
        } else {
            // For non-Vera campuses, just log the simulation
            console.log(`🔄 [Simulation ${almacen}] Would send MQTT messages to start picking pallet at position ${reparto.location} with ${boxCount} boxes`);
        }

        // Remove from database
        await db.none('DELETE FROM reparto WHERE id = $1', [id]);

        // Return success response with position and cantidad
        res.status(200).json({
            success: true,
            posicion: reparto.location,
            cantidad: boxCount,
            almacen: almacen,
            simulation: almacen !== "Vera"
        });

    } catch (error) {
        console.error('Error processing salida particulares:', error);
        res.status(500).json({ error: "Error processing salida particulares" });
    }
});

// Add a new route to handle product exit to other center
app.post("/api/salida-centro", bodyParser.json(), async (req, res) => {
    console.log("Received salida centro request:", req.body);

    // Verify authorization
    if (!verifyPwd(req, res)) {
        return;
    }

    try {
        const { id } = req.body;

        // Get reparto record to find position, cantidad and product details
        const reparto = await db.oneOrNone(
            "SELECT id, almacen, lectura, location, cantidad FROM reparto WHERE id = $1", // Include cantidad
            [id]
        );

        if (!reparto) {
            return res.status(404).json({ error: "Reparto record not found" });
        }

        if (!reparto.location) {
            return res.status(400).json({ error: "This product is not stored in a warehouse location" });
        }

        const almacen = reparto.almacen;
        const boxCount = reparto.cantidad || 10; // Use the stored cantidad or default to 10

        // Store the exit operation in the system state
        systemState.currentOperation = {
            type: 'salida_centro',
            position: reparto.location,
            productId: reparto.lectura,
            cantidad: boxCount, // Add cantidad to the operation state
            almacen: almacen,
            phase: 'picking_from_storage',
            agvTargetPosition: reparto.location
        };

        // Only send MQTT messages for Vera campus
        if (almacen === "Vera") {
            // Publish directive with cantidad
            publishMqttMessage('PR2A1/acciones/directriz', `{"accion": "salida_centro", "posicion": "${reparto.location}", "cantidad": "${boxCount}"}`);
            console.log(`✅ Physical automation started for Vera warehouse at position ${reparto.location} with ${boxCount} boxes`);
        } else {
            // For non-Vera campuses, just log the simulation
            console.log(`🔄 [Simulation ${almacen}] Would send MQTT messages to start picking pallet at position ${reparto.location} with ${boxCount} boxes`);
        }

        // Remove from database
        await db.none('DELETE FROM reparto WHERE id = $1', [id]);

        // Return success response with position and cantidad
        res.status(200).json({
            success: true,
            posicion: reparto.location,
            cantidad: boxCount,
            almacen: almacen,
            simulation: almacen !== "Vera"
        });

    } catch (error) {
        console.error('Error processing salida centro:', error);
        res.status(500).json({ error: "Error processing salida centro" });
    }
});

// Add a route to reset emergency stop state
app.post("/api/reset-emergency", bodyParser.json(), async (req, res) => {
    // Verify authorization
    if (!verifyPwd(req, res)) {
        return;
    }

    systemState.emergencyStop = false;
    console.log('🔄 Emergency stop reset');

    res.status(200).json({ success: true, message: "Emergency stop reset" });
});

// Add a route to get current system status
app.get("/api/system-status", async (req, res) => {
    res.status(200).json({
        systemState,
        connected: mqttConnected
    });
});

// Modify the /api/enviar endpoint to include cantidad field
app.post("/api/enviar", async (req, res) => {
    console.log(req.body);
    const { lectura, almacen, cantidad } = req.body; // Add cantidad to destructuring
    console.log("Received data:", req.body);

    if (verifyPwd(req, res)) {
        try {
            // Insert the data into the database with cantidad field
            const currentTime = new Date();
            const cantidadValue = cantidad ? parseInt(cantidad) : 12;

            await db.none(
                "INSERT INTO reparto(almacen, lectura, timestamp, cantidad) VALUES($1, $2, $3, $4)",
                [almacen, lectura, currentTime, cantidadValue]
            );
            console.log("Data inserted successfully with cantidad:", cantidadValue);

            // Get the ID of the newly inserted record
            const insertedRecord = await db.one(
                "SELECT id FROM reparto WHERE almacen = $1 AND lectura = $2 AND timestamp = $3",
                [almacen, lectura, currentTime]
            );

            // Generate QR code with this data
            generateQRCode(insertedRecord.id, lectura, cantidadValue);

            res.redirect(redirectURL);
        } catch (error) {
            console.error("Error inserting data:", error);
            res.status(500).send("Error inserting data");
        }
    }
});

// Route to fetch all products
app.get("/api/productos", async (req, res) => {
    console.log("Received request for productos");
    try {
        const productos = await db.any("SELECT * FROM producto");
        res.json(productos);
    } catch (error) {
        console.error("Error fetching productos:", error);
        res.status(500).send("Error fetching productos");
    }
});

// Route to fetch all reparto records
app.get("/api/repartos", async (req, res) => {
    try {
        const repartos = await db.any("SELECT * FROM reparto");
        res.json(repartos);
    } catch (error) {
        console.error("Error fetching repartos:", error);
        res.status(500).send("Error fetching repartos");
    }
});

// Route to add a new product
app.post("/api/productos/add", bodyParser.json(), async (req, res) => {
    console.log('Received add product request:', req.body);
    const { id, producto, shelf_life } = req.body;

    // Verify the Authorization header for bearer token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === process.env.ADMIN_PWD) {
            try {
                // Check if product with this ID already exists
                const existing = await db.oneOrNone('SELECT id FROM producto WHERE id = $1', [id]);
                if (existing) {
                    return res.status(409).send(`Product with ID ${id} already exists`);
                }

                // Insert the new product
                await db.none(
                    'INSERT INTO producto (id, producto, shelf_life) VALUES ($1, $2, $3)',
                    [id, producto, shelf_life]
                );

                console.log('Product added successfully:', id);
                res.status(201).json({
                    success: true,
                    message: 'Producto añadido correctamente',
                    product: { id, producto, shelf_life }
                });
            } catch (error) {
                console.error('Error adding product:', error);
                res.status(500).send(`Error adding product: ${error.message}`);
            }
        } else {
            res.status(403).send('Invalid authorization token');
        }
    } else {
        // Fallback to form-based password check for backward compatibility
        if (verifyPwd(req, res)) {
            try {
                // Same implementation as above
                const existing = await db.oneOrNone('SELECT id FROM producto WHERE id = $1', [id]);
                if (existing) {
                    return res.status(409).send(`Product with ID ${id} already exists`);
                }

                await db.none(
                    'INSERT INTO producto (id, producto, shelf_life) VALUES ($1, $2, $3)',
                    [id, producto, shelf_life]
                );

                console.log('Product added successfully:', id);
                res.status(201).json({
                    success: true,
                    message: 'Producto añadido correctamente',
                    product: { id, producto, shelf_life }
                });
            } catch (error) {
                console.error('Error adding product:', error);
                res.status(500).send(`Error adding product: ${error.message}`);
            }
        }
    }
});

// Route to remove a product
app.post("/api/productos/remove/:id", bodyParser.json(), async (req, res) => {
    const { id } = req.params;
    console.log('Received remove product request for id:', id);

    // Verify the Authorization header for bearer token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === process.env.ADMIN_PWD) {
            try {
                // Check if product exists
                const product = await db.oneOrNone('SELECT id FROM producto WHERE id = $1', [id]);
                if (!product) {
                    return res.status(404).send(`Product with ID ${id} not found`);
                }

                // Check if product is being used in reparto
                const inUse = await db.oneOrNone('SELECT id FROM reparto WHERE lectura = $1', [id]);
                if (inUse) {
                    return res.status(409).send(
                        `Cannot delete product ${id} because it is in use in the inventory system`
                    );
                }

                // Delete the product
                await db.none('DELETE FROM producto WHERE id = $1', [id]);

                console.log('Product removed successfully:', id);
                res.json({
                    success: true,
                    message: 'Producto eliminado correctamente',
                    id: id
                });
            } catch (error) {
                console.error('Error removing product:', error);
                res.status(500).send(`Error removing product: ${error.message}`);
            }
        } else {
            res.status(403).send('Invalid authorization token');
        }
    } else {
        // Fallback to form-based password check for backward compatibility
        if (verifyPwd(req, res)) {
            try {
                // Same implementation as above
                const product = await db.oneOrNone('SELECT id FROM producto WHERE id = $1', [id]);
                if (!product) {
                    return res.status(404).send(`Product with ID ${id} not found`);
                }

                const inUse = await db.oneOrNone('SELECT id FROM reparto WHERE lectura = $1', [id]);
                if (inUse) {
                    return res.status(409).send(
                        `Cannot delete product ${id} because it is in use in the inventory system`
                    );
                }

                await db.none('DELETE FROM producto WHERE id = $1', [id]);

                console.log('Product removed successfully:', id);
                res.json({
                    success: true,
                    message: 'Producto eliminado correctamente',
                    id: id
                });
            } catch (error) {
                console.error('Error removing product:', error);
                res.status(500).send(`Error removing product: ${error.message}`);
            }
        }
    }
});

function verifyPwd(req, res) {
    const { password } = req.body;
    if (password === process.env.ADMIN_PWD) {
        return true;
    } else {
        res.status(403).send("Forbidden");
        return false;
    }
}

// Function to generate QR code and save it to disk
async function generateQRCode(id, lectura, cantidad) {
    try {
        // Ensure the QR code directory exists
        const qrDir = path.join(__dirname, 'QR Codes');
        await fs.ensureDir(qrDir);

        // Create the QR data
        const qrData = {
            id: id,
            lectura: lectura,
            cantidad: cantidad
        };

        // Format the timestamp
        const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');

        // Generate the filename
        const filename = `${id}_${lectura}_${timestamp}.png`;
        const filePath = path.join(qrDir, filename);

        // Generate the QR code
        await QRCode.toFile(filePath, JSON.stringify(qrData), {
            color: {
                dark: '#000000',
                light: '#ffffff'
            },
            width: 300,
            margin: 1
        });

        console.log(`✅ QR code generated and saved at: ${filePath}`);
        console.log(`📱 QR code contains: ${JSON.stringify(qrData)}`);

        return filePath;
    } catch (error) {
        console.error('❌ Error generating QR code:', error);
        return null;
    }
}

// Cleanup function for when the application is terminated
function cleanup() {
    console.log('Cleaning up MQTT client...');
    if (mqttClient) {
        mqttClient.end(true, () => {
            console.log('MQTT client disconnected');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
}

// Handle termination signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

app.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
});
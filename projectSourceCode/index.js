const express = require("express");
const { exec } = require("child_process");
const path = require("path");

const app = express();

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

app.get("/", (req, res) => {
    exec("python3 server.py", (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing Python script: ${error}`);
            return res.status(500).send("Error running script.");
        }

        try {
            const data = JSON.parse(stdout);  // Parse the JSON output from Python
            res.render("pages/home", { message: data.message, value: data.value });
        } catch (parseError) {
            console.error(`Error parsing Python output: ${parseError}`);
            res.status(500).send("Error processing script output.");
        }
    });
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));

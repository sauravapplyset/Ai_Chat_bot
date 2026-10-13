const router = require('express').Router();
const { verifyAdmin } = require("../middleware/admin.auth");
const { tokenAndModel } = require("../controller/manageTokens/get");
const { updateToken } = require("../controller/manageTokens/update");

// These return / change provider API keys: admin only
router.post('/gettokens', verifyAdmin, tokenAndModel);
router.post('/updatetokens', verifyAdmin, updateToken);

module.exports = router;

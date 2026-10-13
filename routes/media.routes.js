const router = require('express').Router();
const { middAuth } = require("../middleware/auth");
const { verifyAdmin } = require("../middleware/admin.auth");
const { 
    mediaModelProvider, 
    mediaFeatureProvider, 
    addMediaModel, 
    addMediaFeature 
} = require("../controller/media/mediaController");

// Get Routes
router.get('/models/getAll', mediaModelProvider);
router.post('/features/getAll', mediaFeatureProvider);

// Add Routes
router.post('/models/add', verifyAdmin, addMediaModel);
router.post('/features/add', verifyAdmin, addMediaFeature);

module.exports = router;

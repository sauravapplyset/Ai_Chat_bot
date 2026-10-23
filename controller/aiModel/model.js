const AiModel = require("../../model/aiModel.model");
const { isModelTester } = require("../../helper/modelTesters");
const sequelize = require("../../db/connection");

exports.aiProvider = async (req, res) => {
    try {

        // Test devices also see inactive models, so a new model can be tried in the app
        const query = (order) => AiModel.findAll({
            where: isModelTester(req.body?.deviceId) ? {} : { isActive: 1 },
            attributes: [
                'id',
                'modelName',
                'modelType',
                'imageUrl',
                'isPro',
                'isImage',
                'isVideo',
                'isAudio',
                'isFile',
                'isCamera',
            ],
            order,
        });

        // Order set with the arrows in admin AI Models (models.position); by name until that
        // column exists, so the API keeps working before the migration has run
        let findAllModel;
        try {
            findAllModel = await query([['isActive', 'DESC'], [sequelize.col('position'), 'ASC'], ['id', 'ASC']]);
        } catch (err) {
            if (!/Unknown column/i.test(err.message)) throw err;
            findAllModel = await query([['modelName', 'ASC']]);
        }

        res.status(200).json({
            data: findAllModel
        })
    } catch (error) {
        console.log("---error---", error)
        res.status(500).json({
            message: "Something went wrong",
            status: 500
        })
    }
};
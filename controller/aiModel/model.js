const AiModel = require("../../model/aiModel.model");
const { isModelTester } = require("../../helper/modelTesters");

exports.aiProvider = async (req, res) => {
    try {

        // Test devices also see inactive models, so a new model can be tried in the app
        const findAllModel = await AiModel.findAll({
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
            order: [['modelName', 'ASC']],
        });

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
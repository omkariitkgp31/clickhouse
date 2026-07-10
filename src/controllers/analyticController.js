const analyticsService =
    require("../services/analyticService");


exports.getAnalytics = async (
    req,
    res
) => {

    try {

        const analytics =
            await analyticsService.getAnalytics(
                req.query
            );

        res.status(200).json({
            success: true,
            data: analytics
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
};

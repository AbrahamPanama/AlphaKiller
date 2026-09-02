# AlphaKiller's intentionally small OpenCV.js binding surface.
#
# This file is evaluated by OpenCV's bindings generator, which provides
# makeWhiteList. Keep additions tied to a shipped feature so the WASM payload
# does not quietly grow into a general-purpose OpenCV distribution.

core = {
    '': [
        'absdiff',
        'add',
        'addWeighted',
        'bitwise_and',
        'bitwise_not',
        'compare',
        'copyMakeBorder',
        'countNonZero',
        'inRange',
        'mean',
        'meanStdDev',
        'minMaxLoc',
        'normalize',
        'setLogLevel',
        'getLogLevel',
    ],
    'Algorithm': [],
}

imgproc = {
    '': [
        'approxPolyDP',
        'arcLength',
        'bilateralFilter',
        'boundingRect',
        'Canny',
        'connectedComponents',
        'connectedComponentsWithStats',
        'contourArea',
        'cvtColor',
        'dilate',
        'distanceTransform',
        'distanceTransformWithLabels',
        'drawContours',
        'erode',
        'findContours',
        'fitEllipse',
        'fitEllipseAMS',
        'fitEllipseDirect',
        'fitLine',
        'GaussianBlur',
        'getStructuringElement',
        'grabCut',
        'morphologyEx',
        'pointPolygonTest',
        'resize',
        'threshold',
        'warpAffine',
        'warpPerspective',
    ],
    'segmentation_IntelligentScissorsMB': [
        'IntelligentScissorsMB',
        'setWeights',
        'setGradientMagnitudeMaxLimit',
        'setEdgeFeatureZeroCrossingParameters',
        'setEdgeFeatureCannyParameters',
        'applyImage',
        'applyImageFeatures',
        'buildMap',
        'getContour',
    ],
}

photo = {
    '': ['inpaint'],
}

white_list = makeWhiteList([core, imgproc, photo])

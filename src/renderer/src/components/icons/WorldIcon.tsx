import { forwardRef, useImperativeHandle, useCallback } from "react";

import type { AnimatedIconHandle, AnimatedIconProps } from "./types";

import { motion, useAnimate } from "motion/react";



const WorldIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(

  (

    { size = 24, color = "currentColor", strokeWidth = 2, className = "" },

    ref,

  ) => {

    const [scope, animate] = useAnimate();



    const start = useCallback(async () => {

      // Rotate the globe

      animate(

        ".world-meridians",

        {

          pathLength: [0, 1],

        },

        {

          duration: 1,

          ease: "linear",

        },

      );

    }, [animate]);



    const stop = useCallback(async () => {

      animate(

        ".world-meridians",

        {

          pathLength: 1,

        },

        {

          duration: 0.2,

          ease: "easeInOut",

        },

      );

    }, [animate]);



    useImperativeHandle(ref, () => ({

      startAnimation: start,

      stopAnimation: stop,

    }));



    return (

      <motion.svg

        ref={scope}

        xmlns="http://www.w3.org/2000/svg"

        width={size}

        height={size}

        viewBox="0 0 24 24"

        fill="none"

        stroke={color}

        strokeWidth={strokeWidth}

        strokeLinecap="round"

        strokeLinejoin="round"

        className={`cursor-pointer ${className}`}

        onHoverStart={start}

        onHoverEnd={stop}

      >

        <path stroke="none" d="M0 0h24v24H0z" fill="none" />



        {/* Globe circle */}

        <motion.path

          d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"

          className="world-globe"

          style={{ transformOrigin: "50% 50%" }}

        />



        {/* Horizontal lines and meridians */}

        <motion.g

          className="world-meridians"

          style={{ transformOrigin: "50% 50%" }}

        >

          <motion.path d="M3.6 9h16.8" className="world-meridians" />

          <motion.path d="M3.6 15h16.8" className="world-meridians" />

          <motion.path

            d="M11.5 3a17 17 0 0 0 0 18"

            className="world-meridians"

          />

          <motion.path

            d="M12.5 3a17 17 0 0 1 0 18"

            className="world-meridians"

          />

        </motion.g>

      </motion.svg>

    );

  },

);



WorldIcon.displayName = "WorldIcon";

export default WorldIcon;

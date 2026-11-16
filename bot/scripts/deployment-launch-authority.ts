#!/usr/bin/env bun
import {launchReleaseCommand} from "../src/deployment-launch-authority";
try{process.exitCode=await launchReleaseCommand(process.argv[2]??"",process.argv.slice(3));}
catch(error){console.error(error);process.exitCode=1;}

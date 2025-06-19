const logger = require('../services/loggerService');
function getProjects(client,ProjStatus) {
  return new Promise((resolve, reject) => {
    const projectFullParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD,
      ProjStatus: ProjStatus
    };

    client.GetProjects_Full(projectFullParams, (error, result) => {
      if (error) {
        logger.error('Error calling GetProjects_Full method: '+ error);
        return reject(error); 
      }

      const projects = result.GetProjects_FullResult.Project;

      if (projects && projects.length) {
        logger.info('Total number of projects: '+ projects.length);
        resolve(projects);
      } else {
        //logger.info('No projects found.');
        resolve([]);
      }
    });
  });
}

module.exports = getProjects;
